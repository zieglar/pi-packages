# HANDOFF-PI-CE-NATIVE-DEFAULT-01 — Final implementation and validation

## Status and verdict

**ACCEPT_WITH_FOLLOWUP.** Implementation, targeted real-runtime validation, independent fixed-commit reviews and bounded Public export are complete. **Production publication remains BLOCKED** until separately authorized production Native trust pins and their acceptance. No npm publish, push, Native Release change, production pin change or claim of production enablement occurred.

Implemented and locally committed are not equivalent to tested, dogfooded or released. No dogfooding or production release is claimed.

## Authority and final version policy

The installed Pi 1.3.0 manifest at `node_modules/@earendil-works/pi-coding-agent/package.json` was read directly. Its declaration is **`engines.node: ">=22.19.0"`**, not a Node 24-only requirement. CE's final declaration is also **`>=22.19.0`**, and `scripts/check-contract.mjs` enforces the same string. This is a supported-range declaration, not proof of all later versions.

The Native path additionally requires Node-API >=8, the verified middleware/ABI/target, bundled SQLite identity and compile/behavior probes, plus a trusted cache. The explicit compatibility `node:sqlite` path retains its candidate-range and known-defect refusals. Native does not use `process.versions.sqlite` for its bundled SQLite. No `node:sqlite` crash or version restriction was removed from that compatibility path.

## Native release and trust evidence

Used immutable **`ce-sqlite-v0.1.0`**, ABI **1**, bundled SQLite **3.54.1**, source **`a8386aafd657c84825b2905847f34a43d5b91e1e`**. The published Release's exact eight files were downloaded separately. All four binary hashes match `SHA256SUMS` and independently recomputed digests. All seven attested subjects verified with repository/workflow/source-ref binding and **`--source-digest`**, exit 0. The prepared cache reports the exact source build identity. See `strict-attestation-verify.json` and `asset-digests.json`.

`src/storage/native-compat.ts` is byte-identical to baseline: **all production hashes remain null**. An isolated HOME and manifest carried only test pins. `ce-native prepare`, `select` and `status` loaded the real artifact. The publish preflight now imports the built manifest and its production `parseNativeCompat()`, validates the declared default version and four exact target identities, then refuses any null/missing pin before pack or registry calls. A real unpinned preflight run refused with exit 1.

## Default and failure behavior

Absent selection chooses `rust-native` at the declared default. `node:sqlite` remains in the tree, but is lazy and only loaded after explicit selection, with no fallback. Missing/corrupt/wrong-pin/invalid-ABI and unsafe-cache cases refuse before persistent Store creation. The real default suite proves denial on builtin, CJS and ESM access routes with positive explicit Node controls; it is not just an empty-log assertion. Real Store writes/reopens use WAL and pass integrity checks with zero `DatabaseSync` constructions on the Native path.

Production runtime admission, Store SQL, transactions, idempotency, ACK, Delivery, Ownership and Recovery code was not changed by this work.

## Node × platform × validation matrix

All listed runtime runs are local **Darwin arm64** with the published binary. Hosted Linux is separately marked unverified.

| Node | Result | Limits |
|---|---|---|
| 22.19.0 | Real Native status; native-default 9/9; CI-list 209/209; installed Pi Host first run PASS | Full Rust suite run2 was **1001 passed / 29 failed / 4 skipped**; not a full-suite pass. Failures are in Node-specific driver/test paths. |
| 24.21.0 | Earlier real Native suite and release qualification evidence | No new full final matrix rerun; retained scope only. |
| 24.22.2 | Full Rust suite **1030 passed / 4 skipped / 0 failed**; CI-list 209/209; installed Pi Host first run PASS | Local platform only. |
| 24.19.0 | Earlier run: 1009 passed, 2 failed, 4 skipped; installed Pi Host first run PASS | Failures are explicit Node-driver-only tests. |
| 25.2.1 | Full Rust suite **1027 passed / 3 failed / 4 skipped**; installed Pi Host first run PASS | Failures: Node conformance empty-SQL behavior, cross-driver Store due builtin SQLite 3.50.4, and lock-fixture stderr expectation. |
| 25.9.0 | Earlier run: 1009 passed, 2 failed, 4 skipped; installed Pi Host first run PASS | No full final matrix rerun. |
| 26.12.1 | Real Store scenario probes and installed Pi Host first run PASS | No full Rust suite. |

Every installed Pi Host run also passed installation, Host load, first run and profile/policy/mutex/store checks. Each run records **2 actual Native module resolutions and 0 `node:sqlite` resolutions**. These are isolated offline tests; cloud transport and Native remove/reinstall were not run. See `installed-host-r2-driver-evidence.json`.

The default compatibility suite, explicitly selecting `node-sqlite`, finished **2846 passed / 16 skipped / 0 failed**. This is not a Native full-suite claim. The release scripts passed **73/73** and distribution/release-preparation tests passed **27/27**. Typecheck, build, contract and native static checks passed. The two LSP-inconclusive files were covered by the full TypeScript check rather than called clean.

## Packaging and CI

The npm tarball contains **87 files**: runtime closure, English `README.md`, `LICENSE`, package metadata and required operational assets. It contains no `.node`, `docs/`, Chinese README, private ledger, release scripts or lifecycle hooks. Its SHA-256 is `b36eb904a803264babe3ad3b4ef014c3752f485f92d76627cd6e571efd7b0358`. The exact same bytes passed the installed-Host lanes.

`buildPackageArtifact()` is the single packaging implementation. Preflight builds that artifact, and `publishOnce()` publishes the exact returned `.tgz` path, not the package root. The publish tests assert the exact path. `--validate-only` again performs only validation and creates no new artifact.

CI now has a real Native Linux x64 job on Node 22.19.0 and 24.22.2. It downloads the immutable Release, verifies checksums and attestations against the exact source SHA, prepares an isolated cache and runs the real Native/default/failure tests. The locally equivalent test list passed **209/209 on each Node version**. **Hosted CI was not run** because pushing is not authorized.

## Fixed-commit review evidence

Initial fixed implementation: `81431034ac41fd21105659404877735147e47141`. Four independent lanes found release blockers:

- Lane A: actual publish could bypass minimal staged tarball; six docs incorrectly said Host first-run pending.
- Lane B: gate failed to validate default version/target identity.
- Lane C: coverage limitations identified; minimum full suite and Node 26 full suite not established, 25.2.1 failures preserved.
- Lane D: source-expression parser rejected the real manifest shape; identity validation was weak; preflight and publish could use different packages.

Remediation `a0dc81f9bbfa0aef154f7b4ccfccb21f35ed01dc` reused the compiled production manifest/validator and one artifact path, synchronized six docs, and added real-manifest and wrong-identity tests. All four incremental reviews passed. Final small commit `6669f259fb12e21bee975d99c1eacb5e2d757482` restored validate-only semantics; validation confirms no new artifact. These are context-isolated reviews, not claimed cross-family independence.

## Changed files and export

Private commits:

1. `81431034ac41fd21105659404877735147e47141` — Native default, Pi Host Node policy, real-asset validation, packaging/CI/docs.
2. `a0dc81f9bbfa0aef154f7b4ccfccb21f35ed01dc` — production manifest validation and unique-tarball release remediation.
3. `6669f259fb12e21bee975d99c1eacb5e2d757482` — validate-only behavior preservation.

Public Export **PX-0015**:
**`bb545ae0b686cac4761f47e3e56e1f268ae0cc4f`**, direct parent **PX-0014 `2f3a4670b52b6ad6e661ba44f7527f5d1c9268f7`**. Exactly **36 exported files**, all blobs identical to recorded Private sources. Private plan, `.pi` skills, governance, audit/evidence and untracked `AGENTS.md` / `.herdr-web-ui/` were excluded. PX-0009–PX-0014 remain in the ancestry; none was pushed.

## Unexecuted, failed and skipped evidence

- Node 22.19.0 full Rust suite remains failed as detailed above; only its targeted list is green.
- Node 25.2.1 has three disclosed failures; no all-green claim.
- Node 26 has no full Rust suite.
- Default suite skips 16; Rust suite skips 4. Skips are not coverage.
- No hosted CI, cloud transport, Native remove/reinstall, new Linux local runtime, full cross-version Store-open matrix or power-loss qualification was performed.
- `runtime-cross-version.test.ts` and `runtime-wal-safety.test.ts` were excluded from the full Rust lanes; do not infer those matrices passed everywhere.
- Existing Vitest mock-hoisting warning remains. No safety assertion was weakened to silence it.
- External public GitHub links need live-link checking after a future authorized push; local link checks do not prove main contains this candidate.

## Next authorization required

Production release requires a separate authorization for the exact Native production pins and acceptance of those pins with the Native default as one publishable unit. Then perform the authorized Hosted CI and production-path acceptance before any npm publication. Until then this is an implemented and locally tested candidate, **not production-enabled Native and not a releasable npm version**.
