//! Synchronous SQLite execution for CE. Deliberately narrow: no ORM, no async,
//! no generic database abstraction. Business transactions stay in TypeScript.
//!
//! Statements are prepared per call and finalized at the end of the same call,
//! so there are no native statement handles to leak or outlive a connection.
//! The authorizer is a Rust closure (never re-enters JavaScript).

use napi::bindgen_prelude::*;
use napi::JsValue;
use napi_derive::napi;
use rusqlite::ffi as sqlite_ffi;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, Error, OpenFlags};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

const POLICY_OFF: u32 = 0;
const POLICY_DENY_TX_CONTROL: u32 = 1;
const POLICY_DENY_ALL: u32 = 2;

pub type SqliteValue = Either4<f64, String, Uint8Array, Null>;

fn invalid_state(message: &str) -> napi::Error {
    napi::Error::from_reason(format!(
        "\u{1}CE_SQLITE{}",
        serde_json::json!({"kind":"state","message":message})
    ))
}

fn sqlite_error(code: i32, message: String) -> napi::Error {
    let errstr = unsafe {
        let raw = sqlite_ffi::sqlite3_errstr(code);
        if raw.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned()
        }
    };
    napi::Error::from_reason(format!(
        "\u{1}CE_SQLITE{}",
        serde_json::json!({"kind":"sqlite","code":code,"errstr":errstr,"message":message})
    ))
}

fn argument_error(code: &str, message: &str) -> napi::Error {
    napi::Error::from_reason(format!(
        "\u{1}CE_SQLITE{}",
        serde_json::json!({"kind":"argument","code":code,"message":message})
    ))
}

fn range_error(value: i64) -> napi::Error {
    napi::Error::from_reason(format!(
        "\u{1}CE_SQLITE{}",
        serde_json::json!({"kind":"range","message":format!("Value is too large to be represented as a JavaScript number: {value}")})
    ))
}

fn map_error(error: Error) -> napi::Error {
    match error {
        Error::SqliteFailure(code, message) => sqlite_error(
            code.extended_code,
            message.unwrap_or_else(|| format!("SQLite error {:?}", code.code)),
        ),
        Error::SqlInputError { msg, error, .. } => sqlite_error(error.extended_code, msg),
        Error::InvalidQuery => argument_error(
            "ERR_INVALID_ARG_VALUE",
            "The SQL query contains no statements.",
        ),
        Error::MultipleStatement => argument_error(
            "ERR_INVALID_ARG_VALUE",
            "The SQL query contains more than one statement.",
        ),
        Error::ToSqlConversionFailure(source) => {
            argument_error("ERR_INVALID_ARG_TYPE", &source.to_string())
        }
        other => argument_error("ERR_INVALID_ARG_TYPE", &other.to_string()),
    }
}

fn unexpected(message: String) -> napi::Error {
    argument_error("ERR_INVALID_ARG_TYPE", &message)
}

#[napi(object)]
pub struct OpenOptions {
    pub read_only: Option<bool>,
    pub defensive: Option<bool>,
    pub timeout: Option<i64>,
}

#[napi]
pub struct NativeConnection {
    connection: Option<Connection>,
    denials: Arc<AtomicU32>,
}

#[napi]
impl NativeConnection {
    #[napi(constructor)]
    pub fn new(path: String, options: Option<OpenOptions>) -> Result<Self> {
        if path.is_empty() {
            return Err(argument_error(
                "ERR_INVALID_ARG_VALUE",
                "database path is empty",
            ));
        }
        let read_only = options.as_ref().and_then(|o| o.read_only).unwrap_or(false);
        let defensive = options.as_ref().and_then(|o| o.defensive).unwrap_or(true);
        let timeout = options.as_ref().and_then(|o| o.timeout).unwrap_or(0);
        if timeout < 0 {
            return Err(argument_error(
                "ERR_INVALID_ARG_VALUE",
                "timeout must be a non-negative integer",
            ));
        }
        let flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_FULL_MUTEX
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
        };
        let connection = Connection::open_with_flags(path, flags).map_err(map_error)?;
        connection
            .busy_timeout(std::time::Duration::from_millis(timeout as u64))
            .map_err(map_error)?;
        connection
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY,
                true,
            )
            .map_err(map_error)?;
        connection
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE,
                defensive,
            )
            .map_err(map_error)?;
        Ok(Self {
            connection: Some(connection),
            denials: Arc::new(AtomicU32::new(0)),
        })
    }

    fn connection(&self) -> Result<&Connection> {
        self.connection
            .as_ref()
            .ok_or_else(|| invalid_state("database is not open"))
    }

    fn connection_mut(&mut self) -> Result<&mut Connection> {
        self.connection
            .as_mut()
            .ok_or_else(|| invalid_state("database is not open"))
    }

    fn parameter_values(parameters: Vec<Unknown>, count: usize) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        for (index, parameter) in parameters.into_iter().enumerate() {
            let value = match parameter.get_type()? {
                ValueType::Number => Value::Real(unsafe { parameter.cast::<f64>()? }),
                ValueType::String => Value::Text(unsafe { parameter.cast::<String>()? }),
                ValueType::Null => Value::Null,
                ValueType::Object => {
                    let invalid_blob = |_| {
                        argument_error(
                            "ERR_INVALID_ARG_TYPE",
                            "SQLite BLOB parameters must be Uint8Array values",
                        )
                    };
                    // Unknown::cast does not validate. Validate the TypedArray boundary first;
                    // FromNapiValue then checks that its concrete kind is Uint8Array.
                    unsafe { Uint8Array::validate(parameter.value().env, parameter.raw()) }
                        .map_err(invalid_blob)?;
                    let bytes = unsafe { parameter.cast::<Uint8Array>() }.map_err(invalid_blob)?;
                    Value::Blob(bytes.to_vec())
                }
                other => {
                    return Err(argument_error(
                        "ERR_INVALID_ARG_TYPE",
                        &format!(
                            "Provided value cannot be bound to SQLite parameter {}: {other:?}",
                            index + 1
                        ),
                    ))
                }
            };
            values.push(value);
        }
        if values.len() > count {
            return Err(sqlite_error(
                sqlite_ffi::SQLITE_RANGE,
                "column index out of range".to_string(),
            ));
        }
        // Node SQLite leaves missing positional bindings NULL on each invocation.
        values.resize(count, Value::Null);
        Ok(values)
    }

    fn rows(
        connection: &Connection,
        sql: &str,
        parameters: Vec<Unknown>,
        limit: usize,
    ) -> Result<(Vec<String>, Vec<Vec<SqliteValue>>)> {
        let mut statement = connection.prepare(sql).map_err(map_error)?;
        let values = Self::parameter_values(parameters, statement.parameter_count())?;
        let names = statement
            .column_names()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut result_rows = statement
            .query(rusqlite::params_from_iter(values))
            .map_err(map_error)?;
        while rows.len() < limit {
            match result_rows.next().map_err(map_error)? {
                Some(row) => {
                    let mut output = Vec::new();
                    for index in 0..names.len() {
                        let value = row.get_ref(index).map_err(map_error)?;
                        let converted = match value {
                            ValueRef::Null => Either4::D(Null),
                            ValueRef::Integer(i) => {
                                if i < -9_007_199_254_740_991 || i > 9_007_199_254_740_991 {
                                    return Err(range_error(i));
                                }
                                Either4::A(i as f64)
                            }
                            ValueRef::Real(number) => Either4::A(number),
                            ValueRef::Text(text) => Either4::B(
                                std::str::from_utf8(text)
                                    .map_err(|e| unexpected(e.to_string()))?
                                    .to_string(),
                            ),
                            ValueRef::Blob(bytes) => Either4::C(Uint8Array::new(bytes.to_vec())),
                        };
                        output.push(converted);
                    }
                    rows.push(output);
                }
                None => break,
            }
        }
        Ok((names, rows))
    }

    #[napi]
    pub fn query(
        &self,
        sql: String,
        parameters: Vec<Unknown>,
        limit: u32,
    ) -> Result<(Vec<String>, Vec<Vec<SqliteValue>>)> {
        Self::rows(self.connection()?, &sql, parameters, limit as usize)
    }

    #[napi]
    pub fn execute(&self, sql: String, parameters: Vec<Unknown>) -> Result<(i64, i64)> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(&sql).map_err(map_error)?;
        let values = Self::parameter_values(parameters, statement.parameter_count())?;
        let mut result_rows = statement
            .query(rusqlite::params_from_iter(values))
            .map_err(map_error)?;
        result_rows.next().map_err(map_error)?;
        Ok((connection.changes() as i64, connection.last_insert_rowid()))
    }

    #[napi]
    pub fn prepare_only(&self, sql: String) -> Result<()> {
        if sql.trim().is_empty() {
            return Err(argument_error(
                "ERR_INVALID_ARG_VALUE",
                "The SQL query contains no statements.",
            ));
        }
        self.connection()?
            .prepare(&sql)
            .map(|_| ())
            .map_err(map_error)
    }

    #[napi]
    pub fn exec(&self, sql: String) -> Result<()> {
        self.connection()?.execute_batch(&sql).map_err(map_error)
    }

    #[napi]
    pub fn is_transaction(&self) -> Result<bool> {
        Ok(!self.connection()?.is_autocommit())
    }

    #[napi]
    pub fn enable_defensive(&self, enabled: bool) -> Result<()> {
        self.connection()?
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE,
                enabled,
            )
            .map_err(map_error)?;
        Ok(())
    }

    #[napi]
    pub fn set_authorizer_policy(&mut self, policy: u32) -> Result<()> {
        if policy > POLICY_DENY_ALL {
            return Err(argument_error(
                "ERR_INVALID_ARG_VALUE",
                "unknown authorizer policy",
            ));
        }
        if policy == POLICY_DENY_TX_CONTROL {
            self.denials.store(0, Ordering::SeqCst);
        }
        let denials = Arc::clone(&self.denials);
        let connection = self.connection_mut()?;
        connection
            .authorizer(Some(move |context: AuthContext<'_>| {
                let deny = match policy {
                    POLICY_OFF => false,
                    POLICY_DENY_TX_CONTROL => matches!(
                        context.action,
                        AuthAction::Transaction { .. } | AuthAction::Savepoint { .. }
                    ),
                    POLICY_DENY_ALL => true,
                    _ => true,
                };
                if deny {
                    denials.fetch_add(1, Ordering::SeqCst);
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))
            .map_err(map_error)
    }

    #[napi]
    pub fn authorizer_denials(&self) -> Result<u32> {
        self.connection()?;
        Ok(self.denials.load(Ordering::SeqCst))
    }

    #[napi]
    pub fn close(&mut self) -> Result<()> {
        let Some(connection) = self.connection.take() else {
            return Err(invalid_state("database is not open"));
        };
        connection.close().map_err(|(_, error)| map_error(error))?;
        Ok(())
    }
}

#[napi]
pub fn abi_version() -> i32 {
    1
}

#[napi]
pub fn info() -> String {
    serde_json::json!({
    "middlewareVersion": env!("CARGO_PKG_VERSION"),
    "abiVersion": abi_version(),
    "target": env!("CE_SQLITE_TARGET"),
    "buildId": env!("CE_SQLITE_BUILD_ID"),
    "rustc": env!("CE_SQLITE_RUSTC"),
    "sqliteVersion": unsafe {
      std::ffi::CStr::from_ptr(sqlite_ffi::sqlite3_libversion()).to_string_lossy()
    },
    "sqliteSourceId": unsafe {
      std::ffi::CStr::from_ptr(sqlite_ffi::sqlite3_sourceid()).to_string_lossy()
    },
    "compileOptions": {
      "threadsafe": unsafe { sqlite_ffi::sqlite3_threadsafe() },
      "defaultMutex": if cfg!(any(target_os = "macos", target_os = "linux")) { "MUTEX_PTHREADS" } else { "unknown" },
    },
  }).to_string()
}
