// HANDOFF-CE-HOST-09 B1.1 Task 2 — minimal macOS Keychain helper.
//
// One operation per process. The request arrives as a bounded frame on stdin:
//
//     v1 <op> <accountByteLength> <secretByteLength>[ <keychainPathByteLength>][ interactive]
//     <account bytes><secret bytes><keychain path bytes>
//
// B1.1-INTEGRATION: the literal trailing token `interactive` is accepted on
// `read` ONLY. It enables the NATIVE macOS authorization prompt for that one
// read (the user-triggered authorize path). Every other invocation runs with
// interaction disabled, exactly as before.
// The frame is read ONLY from file descriptor 0 through a single reader, with a
// bounded header scan and an exact-length payload read. Nothing is read with
// `readLine` (which buffers in C stdio and would desynchronise a later
// descriptor read) and nothing is read with `readDataToEndOfFile` (which would
// allocate before the length bound is known).
//
// The secret is DATA only: it never appears in argv, in the environment, in a
// file, in a shell/interpreter command string, or in any diagnostic. Responses
// are a single fixed-shape JSON line on stdout; the only free-form field is a
// fixed reason token from the closed list below. Raw OSStatus text is never
// emitted, so the caller cannot be used as an error-message oracle.
//
// Scope discipline (keychain-design-recon.md):
// - legacy macOS Keychain, resolved ONCE per process. By DEFAULT that is the
//   default keychain (SecKeychainCopyDefault) and production behaviour is
//   unchanged. The optional fifth header field names exactly ONE keychain file,
//   which is opened with SecKeychainOpen; it exists so the authorized probe can
//   target an exclusively owned temporary keychain WITHOUT mutating the default
//   keychain. The default keychain and the search list are never set, modified,
//   or extended, and the path is supplied only by the explicitly configured
//   test/probe runner option — never by a CE command, profile, or environment
//   variable.
// - never the whole default search list, never a prefix or service-wide match.
// - exact generic-password class + exact service + exact account.
// - create installs an access object with an EXPLICIT EMPTY trusted-application
//   list (documented equivalent of `security -T ""`). nil would trust the
//   creating application and `-A` style allow-all is never used.
// - update/read inspect the existing ACL and REFUSE when it is broader than the
//   empty-trusted-app policy. The helper never "repairs", adopts, or widens an
//   ACL, never touches partition lists, and never automates an OS prompt.
// - deletion and modification always target the exact resolved item reference.
//
// Error semantics: native `errSecItemNotFound` is -25300. The `security(1)`
// CLI's "not found" exit status is a CLI-only convention and is deliberately
// NOT recognised here; this helper reports absence only from the native status.
//
// NOT VERIFIED in B1.1 by the implementing worker: compilation, runtime Keychain
// CRUD, ACL behaviour, and prompt behaviour. Those require the authorized
// fake-item probe in an exclusively owned temporary Keychain.
import Foundation
import Security

let maxAccountBytes = 128
let maxSecretBytes = 4096
let maxKeychainPathBytes = 1024
let maxHeaderBytes = 96
let allowedOps = ["exists", "read", "create", "update", "delete"]

func respond(_ line: String) -> Never {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    exit(0)
}

func ok() -> Never { respond(#"{"status":"ok"}"#) }

func okSecret(_ secret: String) -> Never {
    // The secret travels only on this private stdout pipe, which the credential
    // adapter is the sole reader of.
    let encoded = Data(secret.utf8).base64EncodedString()
    respond(#"{"status":"ok","secretBase64":"\#(encoded)"}"#)
}

func notFound() -> Never { respond(#"{"status":"not_found"}"#) }

/// Fixed reason tokens only: `bad_request`, `unavailable`, `acl_too_broad`,
/// `already_exists`, `authorization_required`, `user_canceled`.
func failure(_ reason: String) -> Never {
    respond(#"{"status":"error","reason":"\#(reason)"}"#)
}

/// Absolute, single-line, NUL-free, bounded. Nothing is created or mutated from
/// this path: it only selects which single keychain is opened.
func validKeychainPath(_ path: String) -> Bool {
    if !path.hasPrefix("/") { return false }
    if path.utf8.count > maxKeychainPathBytes { return false }
    for scalar in path.unicodeScalars {
        if scalar == "\0" || scalar == "\n" || scalar == "\r" { return false }
    }
    return true
}

func validAccount(_ account: String) -> Bool {
    if account.isEmpty || account.utf8.count > maxAccountBytes { return false }
    for scalar in account.unicodeScalars {
        let isLower = scalar >= "a" && scalar <= "z"
        let isUpper = scalar >= "A" && scalar <= "Z"
        let isDigit = scalar >= "0" && scalar <= "9"
        let isPunct = scalar == ":" || scalar == "-" || scalar == "_" || scalar == "."
        if !(isLower || isUpper || isDigit || isPunct) { return false }
    }
    return true
}

// Default: NEVER surface interactive UI from this helper. The B1.1-INTEGRATION
// authorize path is the single exception, enabled explicitly by the trailing
// `interactive` frame token AFTER the frame has been parsed and validated —
// an unattended caller can never trigger an approval request by accident.
SecKeychainSetUserInteractionAllowed(false)

// Single reader on fd 0, used for both the header and the payload.
let input = FileHandle.standardInput

/// Bounded header scan: at most `maxHeaderBytes` bytes before the newline, so a
/// caller cannot force an unbounded allocation by never terminating the line.
func readHeaderLine() -> String? {
    var bytes = [UInt8]()
    while bytes.count <= maxHeaderBytes {
        guard let chunk = try? input.read(upToCount: 1), let byte = chunk.first else { return nil }
        if byte == 0x0a { return String(bytes: bytes, encoding: .utf8) }
        bytes.append(byte)
    }
    return nil
}

/// Exact-length read: only after the declared bound has been validated.
func readExactly(_ count: Int) -> [UInt8]? {
    if count == 0 { return [] }
    var bytes = [UInt8]()
    bytes.reserveCapacity(count)
    while bytes.count < count {
        guard let chunk = try? input.read(upToCount: count - bytes.count), !chunk.isEmpty else { return nil }
        bytes.append(contentsOf: chunk)
    }
    return bytes
}

guard let header = readHeaderLine() else { failure("bad_request") }
let fields = header.split(separator: " ").map(String.init)
guard fields.count >= 4, fields.count <= 6, fields[0] == "v1", allowedOps.contains(fields[1]),
      let accountLength = Int(fields[2]), let secretLength = Int(fields[3]),
      accountLength > 0, accountLength <= maxAccountBytes,
      secretLength >= 0, secretLength <= maxSecretBytes
else { failure("bad_request") }

var keychainPathLength = 0
var allowInteraction = false
if fields.count == 5 {
    if let declared = Int(fields[4]) {
        guard declared > 0, declared <= maxKeychainPathBytes else { failure("bad_request") }
        keychainPathLength = declared
    } else if fields[4] == "interactive" {
        guard fields[1] == "read" else { failure("bad_request") }
        allowInteraction = true
    } else {
        failure("bad_request")
    }
} else if fields.count == 6 {
    guard fields[5] == "interactive", fields[1] == "read",
          let declared = Int(fields[4]), declared > 0, declared <= maxKeychainPathBytes
    else { failure("bad_request") }
    keychainPathLength = declared
    allowInteraction = true
}

// The single B1.1-INTEGRATION exception: enable the native authorization
// prompt for THIS process only when the validated frame asked for it.
SecKeychainSetUserInteractionAllowed(allowInteraction)

let operation = fields[1]
let totalLength = accountLength + secretLength + keychainPathLength
guard let payload = readExactly(totalLength) else { failure("bad_request") }
// The frame is exact: trailing bytes are a protocol violation, not padding.
if let trailing = (try? input.read(upToCount: 1)) ?? nil, !trailing.isEmpty { failure("bad_request") }

guard let account = String(bytes: payload[0..<accountLength], encoding: .utf8), validAccount(account)
else { failure("bad_request") }
let secretData = Data(payload[accountLength..<(accountLength + secretLength)])
var requestedKeychainPath: String?
if keychainPathLength > 0 {
    guard let path = String(bytes: payload[(accountLength + secretLength)..<totalLength], encoding: .utf8),
          validKeychainPath(path)
    else { failure("bad_request") }
    requestedKeychainPath = path
}
let needsSecret = operation == "create" || operation == "update"
if needsSecret && secretLength == 0 { failure("bad_request") }
if !needsSecret && secretLength != 0 { failure("bad_request") }

let service = "pi-chat-exchange-tunnel"
let serviceBytes = Array(service.utf8)
let accountBytes = Array(account.utf8)

// Exactly one keychain is resolved for this process: either the production
// default keychain, or the ONE explicitly named probe keychain. Neither the
// default keychain setting nor any search list is read or written.
var keychain: SecKeychain?
if let requestedKeychainPath {
    guard SecKeychainOpen(requestedKeychainPath, &keychain) == errSecSuccess, let opened = keychain else {
        failure("unavailable")
    }
    // SecKeychainOpen also succeeds for a path that does not exist, so the
    // keychain is probed for an actual status before anything is attempted.
    var keychainStatus = SecKeychainStatus()
    guard SecKeychainGetStatus(opened, &keychainStatus) == errSecSuccess else { failure("unavailable") }
} else {
    if SecKeychainCopyDefault(&keychain) != errSecSuccess { failure("unavailable") }
}

/// Exact-match lookup: class + service + account, no wildcard and no fallback.
/// This NEVER requests the secret. Every path first resolves metadata only, so
/// the ACL can be validated before any value is asked for.
func findExactItem() -> (OSStatus, SecKeychainItem?) {
    var itemRef: SecKeychainItem?
    let status = SecKeychainFindGenericPassword(
        keychain,
        UInt32(serviceBytes.count), service,
        UInt32(accountBytes.count), account,
        nil, nil, &itemRef
    )
    guard status == errSecSuccess else { return (status, nil) }
    return (status, itemRef)
}

/// Retrieve the value through the EXACT item reference that was already found
/// and ACL-validated. Requesting the secret is the last step, never the first.
/// Retrieve the value through the EXACT item reference that was already found
/// and ACL-validated. Requesting the secret is the last step, never the first.
/// B1.1-INTEGRATION: the native status is returned so the caller can classify
/// authorization outcomes (-25293 / -128) into closed reason tokens.
func copySecretData(_ item: SecKeychainItem) -> (OSStatus, Data?) {
    var length: UInt32 = 0
    var pointer: UnsafeMutableRawPointer?
    let status = SecKeychainItemCopyContent(item, nil, nil, &length, &pointer)
    guard status == errSecSuccess, let pointer
    else { return (status, nil) }
    let data = Data(bytes: pointer, count: Int(length))
    SecKeychainItemFreeContent(nil, pointer)
    return (status, data)
}

/// READ policy. The stored policy is "no application may read this item
/// without an explicit user decision". B1.1-INTEGRATION refines the shipped
/// check with the KEYCHAIN-GATE-verified user-authorization state:
/// - every secret-reading ACL must carry a NON-NIL application list (nil means
///   "all applications" and is still refused);
/// - an EMPTY list is the not-yet-authorized state and is accepted;
/// - a NON-EMPTY list is accepted ONLY as the user-approved state, and only
///   while the ChangeACL authorization itself still carries an EMPTY list:
///   since every ACL modification then requires an explicit user decision, a
///   non-empty read list can only be the result of the user approving the
///   native prompt (verified in B1.1-KEYCHAIN-GATE: Always Allow added exactly
///   one entry and left ChangeACL empty).
///
/// Fail closed in every ambiguous case. An access object that cannot be copied,
/// an ACL list that cannot be enumerated, an empty ACL list, an authorization
/// list that is absent or unreadable, or an application list that is nil (which
/// means "all applications") all REFUSE. The absence of any secret-reading ACL
/// is not treated as "unrestricted but harmless".
func aclReadAcceptable(_ item: SecKeychainItem) -> Bool {
    var access: SecAccess?
    guard SecKeychainItemCopyAccess(item, &access) == errSecSuccess, let access else { return false }
    var aclList: CFArray?
    guard SecAccessCopyACLList(access, &aclList) == errSecSuccess,
          let acls = aclList as? [SecACL], !acls.isEmpty else { return false }
    var sawRestrictedReadAcl = false
    var sawUserApprovedReadAcl = false
    var sawChangeGovernanceAcl = false
    for acl in acls {
        var applications: CFArray?
        var description: CFString?
        var prompt = SecKeychainPromptSelector()
        guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess else { return false }
        let rawAuthorizations: CFArray? = SecACLCopyAuthorizations(acl)
        guard let authorizations = rawAuthorizations as? [String] else { return false }
        let readish = authorizations.contains(kSecACLAuthorizationDecrypt as String)
            || authorizations.contains(kSecACLAuthorizationExportClear as String)
            || authorizations.contains(kSecACLAuthorizationExportWrapped as String)
            || authorizations.contains(kSecACLAuthorizationAny as String)
        let governsAcl = authorizations.contains(kSecACLAuthorizationChangeACL as String)
            || authorizations.contains(kSecACLAuthorizationAny as String)
        if !readish && !governsAcl { continue }
        guard let trusted = applications as? [SecTrustedApplication] else { return false }
        if readish {
            if trusted.isEmpty { sawRestrictedReadAcl = true } else { sawUserApprovedReadAcl = true }
        }
        if governsAcl {
            sawChangeGovernanceAcl = true
            // An application that can edit the ACLs unattended ends the
            // user-decision guarantee; refuse instead of adopting the drift.
            if !trusted.isEmpty { return false }
        }
    }
    if sawUserApprovedReadAcl { return sawChangeGovernanceAcl }
    return sawRestrictedReadAcl
}

/// UPDATE policy: the pristine shipped state only. Every secret-reading ACL
/// must carry an explicitly EMPTY trusted-application list (nil still means
/// "all applications" and is refused), and at least one such ACL must exist.
/// B1.1-INTEGRATION round 3 (Lane S S-R2-01): every ACL that authorizes
/// modifying this item's own access control without a user decision
/// (ChangeACL or Any) must ALSO carry an explicitly empty, non-nil trusted
/// list. An attacker-pre-planted item can pass the empty-read-list check and
/// still name the attacker's program in a separate ChangeACL ACL; without
/// this governance check `update` would write the new secret into that item
/// and the attacker could then grant itself read access unattended. Missing
/// or unreadable governance state fails closed exactly like the read state.
/// At least one ChangeACL/Any ACL must be present; absence is not evidence
/// that future ACL changes require a user decision.
/// After the user chooses Always Allow the read list is no longer empty, so
/// rotation requires delete + create + one new authorization — a documented,
/// deliberate cost instead of an adoptable ambiguity.
func aclUpdateAcceptable(_ item: SecKeychainItem) -> Bool {
    var access: SecAccess?
    guard SecKeychainItemCopyAccess(item, &access) == errSecSuccess, let access else { return false }
    var aclList: CFArray?
    guard SecAccessCopyACLList(access, &aclList) == errSecSuccess,
          let acls = aclList as? [SecACL], !acls.isEmpty else { return false }
    var sawRestrictedReadAcl = false
    var sawChangeGovernanceAcl = false
    for acl in acls {
        var applications: CFArray?
        var description: CFString?
        var prompt = SecKeychainPromptSelector()
        guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess else { return false }
        let rawAuthorizations: CFArray? = SecACLCopyAuthorizations(acl)
        guard let authorizations = rawAuthorizations as? [String] else { return false }
        let readish = authorizations.contains(kSecACLAuthorizationDecrypt as String)
            || authorizations.contains(kSecACLAuthorizationExportClear as String)
            || authorizations.contains(kSecACLAuthorizationExportWrapped as String)
            || authorizations.contains(kSecACLAuthorizationAny as String)
        let governsAcl = authorizations.contains(kSecACLAuthorizationChangeACL as String)
            || authorizations.contains(kSecACLAuthorizationAny as String)
        if !readish && !governsAcl { continue }
        guard let trusted = applications as? [SecTrustedApplication] else { return false }
        if !trusted.isEmpty { return false }
        if readish { sawRestrictedReadAcl = true }
        if governsAcl { sawChangeGovernanceAcl = true }
    }
    return sawRestrictedReadAcl && sawChangeGovernanceAcl
}

switch operation {
case "exists":
    let (status, _) = findExactItem()
    if status == errSecItemNotFound { notFound() }
    if status != errSecSuccess { failure("unavailable") }
    ok()

case "read":
    // Metadata FIRST: the exact item is resolved and its ACL validated before
    // the secret is requested at all, so a broad-ACL item never has its value
    // copied out of the keychain.
    let (status, item) = findExactItem()
    if status == errSecItemNotFound { notFound() }
    guard status == errSecSuccess, let item else { failure("unavailable") }
    if !aclReadAcceptable(item) { failure("acl_too_broad") }
    let (readStatus, data) = copySecretData(item)
    // B1.1-INTEGRATION: classify the native authorization outcomes instead of
    // collapsing them into unavailability. -25293 errSecAuthFailed with no
    // interaction available means THIS code identity has no user decision
    // yet; -128 errSecUserCanceled means the user dismissed the prompt.
    if readStatus == errSecAuthFailed { failure("authorization_required") }
    if readStatus == errSecUserCanceled { failure("user_canceled") }
    guard readStatus == errSecSuccess, let data else { failure("unavailable") }
    guard let secret = String(data: data, encoding: .utf8) else { failure("unavailable") }
    okSecret(secret)

case "create":
    let (existing, _) = findExactItem()
    if existing == errSecSuccess { failure("already_exists") }
    if existing != errSecItemNotFound { failure("unavailable") }
    // Documented equivalent of `security … -T ""`: an explicit EMPTY list.
    let emptyTrustedApps = [] as CFArray
    var access: SecAccess?
    if SecAccessCreate(service as CFString, emptyTrustedApps, &access) != errSecSuccess { failure("unavailable") }
    guard let access else { failure("unavailable") }
    var attributes = [
        SecKeychainAttribute(tag: SecItemAttr.serviceItemAttr.rawValue, length: UInt32(serviceBytes.count),
                             data: UnsafeMutableRawPointer(mutating: (service as NSString).utf8String)),
        SecKeychainAttribute(tag: SecItemAttr.accountItemAttr.rawValue, length: UInt32(accountBytes.count),
                             data: UnsafeMutableRawPointer(mutating: (account as NSString).utf8String)),
    ]
    var created: SecKeychainItem?
    let createStatus = attributes.withUnsafeMutableBufferPointer { buffer -> OSStatus in
        var list = SecKeychainAttributeList(count: UInt32(buffer.count), attr: buffer.baseAddress)
        return secretData.withUnsafeBytes { bytes in
            SecKeychainItemCreateFromContent(
                SecItemClass.genericPasswordItemClass, &list,
                UInt32(secretData.count), bytes.baseAddress,
                keychain, access, &created
            )
        }
    }
    if createStatus != errSecSuccess { failure("unavailable") }
    ok()

case "update":
    let (status, item) = findExactItem()
    if status == errSecItemNotFound { notFound() }
    guard status == errSecSuccess, let item else { failure("unavailable") }
    // UPDATE policy (Lane S S-01, rework round): STRICTER than the read policy.
    // An empty ChangeACL list constrains only FUTURE ACL modifications; it
    // cannot prove that a non-empty read trusted list was created by a user
    // approval. An attacker who pre-creates this exact service/account item
    // with their own app trusted (and an empty ChangeACL) would otherwise
    // receive the newly typed secret through `update`. Reading such an item
    // leaks nothing (our read still fails), so only `read` accepts the
    // user-approved state; `update` requires the pristine empty-list state
    // and never adopts, repairs, or recreates a drifted item.
    // B1.1-INTEGRATION round 3 (Lane S S-R2-01): the check now ALSO refuses an
    // item whose ChangeACL/Any authorization names ANY trusted application:
    // that program could admit itself to the read list after our update, so
    // an attacker-pre-planted governance right can never receive the secret.
    if !aclUpdateAcceptable(item) { failure("acl_too_broad") }
    let updateStatus = secretData.withUnsafeBytes { bytes in
        SecKeychainItemModifyAttributesAndData(item, nil, UInt32(secretData.count), bytes.baseAddress)
    }
    if updateStatus != errSecSuccess { failure("unavailable") }
    ok()

case "delete":
    let (status, item) = findExactItem()
    if status == errSecItemNotFound { notFound() }
    guard status == errSecSuccess, let item else { failure("unavailable") }
    if SecKeychainItemDelete(item) != errSecSuccess { failure("unavailable") }
    ok()

default:
    failure("bad_request")
}
