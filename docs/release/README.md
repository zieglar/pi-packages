# Private → Public Export Ledger

`public-export-ledger.jsonl` is the authoritative mapping record between accepted Private development sources and independently committed Public exports. It stays in the Private repository and is never part of a Public export. Append events; do not rewrite or delete history.

Each JSON object is one event with schema version1. `exportId` identifies a sequence, `seq` is contiguous, `sourceCommits` lists actual Private commits whose paths are included, `sourceHead` identifies the accepted source state, and `targetBase` / `targetCommit` identify the Public-descended export. `exportedPaths` records each path's last source commit and Git blob. `contentDigest` is SHA-256 over the sorted `path\0blob\n` entries. It does not imply commit identity across unrelated histories.

Status values:

- `PENDING_EXPORT`: the target commit does not yet exist.
- `COMMITTED`: a new Public-descended local commit exists.
- `PUSHED`: an explicitly authorized remote update was verified.
- `CI_VERIFIED`: exact Public commit has hosted evidence.
- `VERIFIED`: backfilled mapping proven by Git blob/diff evidence or existing reports.
- `UNKNOWN`: source is not established; no guessed mapping.

Backfilled records have `backfilled: true`; they do not claim real-time recording. `sourceHead` and `targetCommit` are never considered equivalent commits, even if some file blobs are identical. Public commit messages must include the corresponding `Export-ID`.

`public-export-ledger.schema.json` documents the format. Validate structure, transitions and content digests with:

```sh
node docs/release/validate-public-export-ledger.mjs
```

To additionally verify source and target Git objects, set `PUBLIC_GIT_OBJECTS` to the Public repository's object directory and run `node docs/release/validate-public-export-ledger.mjs --git-verify`. The validator is a Private development utility and is not part of Public workflows. Never record credentials, private absolute paths, tokens or evidence directories in the ledger.
