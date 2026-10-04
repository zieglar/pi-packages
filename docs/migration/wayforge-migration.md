# Wayforge History-Preserving Migration

## Frozen source

- Repository: `/Users/zieglar/Code/wayforge`
- Branch: `phase-1b2-durable-execution`
- HEAD: `d903cd52fc20b9b63f15a5d7d9c6b4d5ca600276`
- Commit count: 3
- Preflight worktree: clean

The preflight used the source npm environment. `npm ci`, build, typecheck, 41 test files/289 tests, nine architecture gates, Alpha 0, and Alpha 1 all passed.

The deterministic source tree and file hashes are preserved in `wayforge-source-snapshot.txt`.

## Toolchain

- Git: 2.56.0
- git-filter-repo: `a40bce548d2c`
- Node.js: v25.2.1 locally; workspace minimum and CI major are Node 22
- pnpm: 12.9.1, invoked through scoped `mise exec` without changing a global default
- Corepack: not active in the local mise environment

## Method

1. Commit the empty workspace scaffold.
2. Clone the frozen source using `git clone --no-local`.
3. Run `git filter-repo --to-subdirectory-filter packages/wayforge --force` only in the disposable clone.
4. Verify the rewritten tree exactly equals the frozen source tree and representative `git log --follow` histories reach rewritten Phase 1A/1B commits.
5. Merge the rewritten branch with `--allow-unrelated-histories --no-ff`.
6. Apply package-manager, TypeScript inheritance, script-path, CI, documentation, and migration-evidence changes in a separate adaptation commit.

The original source repository was never rewritten.

## Destination commits

- Scaffold: `579c86321e2e7fa486c88765d491fa163fec7aab`
- History import merge: `9867ffdad3596da83be94e4883cb552abe3c3a94`
- Workspace adaptation: the commit containing this evidence record; its exact SHA is recorded in the Phase 1.0 acceptance report because a commit cannot contain its own final hash.

The `migration-pre-wayforge` tag and `migration-backup` branch point to the scaffold commit.

## Commit mapping

The unedited `git filter-repo` map is preserved in `wayforge-commit-map.txt`:

```text
98c640ec3a4c5ac3ecb83458254984fcf3601dc7 -> 9a71aaebe5d6831874a4c37dde927d9c769ac863
442ae7675895b3e42089803853fc72e341e62c35 -> 1c401315acd1f4cf65fd0908a9a8ad3fad7820a6
d903cd52fc20b9b63f15a5d7d9c6b4d5ca600276 -> e7097abcf8fd5ee50939809d350a28cf218c6597
```

The Alpha 0 ancestry gate now refers to the rewritten Phase 1A commit. Historical documents retain original source commit identifiers.

## Package-manager migration

- Removed the nested npm lockfile and the historical package-local npm release-age override.
- Preserved every direct dependency declaration and installed direct version.
- Added the authoritative root `pnpm-lock.yaml`.
- pnpm generated narrow `minimumReleaseAgeExclude` entries for the pinned Earendil 1.0.2 package family, preserving the owner-level supply-chain delay for all other packages.
- Explicitly allowed lifecycle builds only for locked transitive packages `@google/genai@2.21.0`, `esbuild@0.28.2`, and `protobufjs@7.6.6`. The first clean install correctly failed closed until these exact approvals were declared.

## Semantic preservation

After adaptation:

- `src/` is byte-identical to the frozen source;
- `test/` is byte-identical to the frozen source;
- package `docs/` is byte-identical to the frozen source;
- effective TypeScript compiler options for check and build configurations are identical;
- no runtime dependency versions changed;
- only package-manager commands, the rewritten Alpha ancestry identifier, TypeScript config inheritance, and migration infrastructure changed.

Final command results and destination cleanliness are recorded in the Phase 1.0 acceptance report.
