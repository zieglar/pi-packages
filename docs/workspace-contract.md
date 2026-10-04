# Pi Packages Workspace Contract

## Repository and ownership

Packages live only under `packages/*`. The root owns the pinned package manager, lockfile, shared TypeScript defaults, workspace orchestration, CI, Changesets, boundary validation, and repository-wide documentation. Each package owns its manifest, implementation, tests, build configuration, README, package documentation, dependencies, and license.

The initial package inventory is exactly `wayforge`. A new package requires an independently useful ownership boundary, a concrete consumer or use case, an owner, tests, documentation, and a license/release decision. Speculative shared packages are prohibited.

## Package independence

Every public package must be independently buildable, typecheckable, testable, documented, packageable, versioned, and publishable. Private packages must state why they are private. Every package exposes `typecheck`, `test`, and `check`; packages that emit artifacts also expose `build`.

Versions are independent. Changesets records release intent; fixed and linked version groups are not used.

## Dependencies

Runtime imports belong in `dependencies`. Host-provided Pi APIs belong in `peerDependencies` with exact development versions when a package is prepared for publication. Compatible internal dependencies use `workspace:^`; exact internal coupling requires explicit justification.

Optional extension integrations use versioned, extension-neutral protocols and must preserve standalone operation when the provider is absent. Wayforge has no compile-time or runtime dependency on `@narumitw/pi-accounts`; future account integration remains an optional EventBus capability.

## TypeScript and builds

Packages extend `tsconfig.base.json` but retain package-specific inputs, outputs, and stricter options. Cross-package path aliases and project references are not used. Wayforge remains a compiled ESM package using TypeScript, NodeNext, ES2023, declarations, and source maps.

## Tests and boundaries

Package tests live with their package and must be independently runnable. Root commands run the full workspace while it remains small.

Cross-package imports must use declared package names and exported entry points. Relative imports that escape a package, imports of another package's `src/` or `dist/`, undeclared internal dependencies, nested lockfiles, and circular runtime dependency graphs are prohibited.

## Documentation and licensing

Root documentation covers workspace-wide architecture, contribution, migration, release, lifecycle, security, and licensing policy. Package documentation covers package behavior and operations.

Licenses are package-specific. Every public package requires package-local license text and SPDX metadata; copied or derived material requires appropriate notices. No root license is implied across all packages.

## Lifecycle

Package creation requires a real independent boundary and consumer. Deprecation requires notice, a migration path, a final release when applicable, npm deprecation metadata, consumer migration, and explicit removal from active workspace/release membership. Package identities are not silently reused.

## Releases

A future public release flows through CI, a Changesets version PR, a clean frozen-lockfile build/test/package gate, npm publication with provenance, and a package-specific Git tag/release. Release automation is intentionally deferred until publication is authorized.
