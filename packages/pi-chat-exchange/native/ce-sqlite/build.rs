use std::process::Command;

fn main() {
    napi_build::setup();
    println!("cargo:rerun-if-env-changed=CE_BUILD_ID");
    println!(
        "cargo:rustc-env=CE_SQLITE_TARGET={}",
        std::env::var("TARGET").unwrap_or_else(|_| "unknown".into())
    );
    println!(
        "cargo:rustc-env=CE_SQLITE_BUILD_ID={}",
        std::env::var("CE_BUILD_ID").unwrap_or_else(|_| "local".into())
    );
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let version = Command::new(rustc)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=CE_SQLITE_RUSTC={version}");
}
