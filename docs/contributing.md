# Contributing

## Setup

Use Node.js 22 or newer and the exact pnpm version declared in the root `packageManager` field.

```bash
pnpm install --frozen-lockfile
```

## Required validation

Before submitting a change, run:

```bash
pnpm check:workspace
pnpm build
pnpm typecheck
pnpm test
pnpm check
pnpm format:check
```

Package-specific commands may be run from the package directory. Root orchestration remains the acceptance gate.

## Change boundaries

- Keep package business logic and package-specific documentation in the owning package.
- Do not import another package through relative paths, `src/`, or `dist/`.
- Declare every cross-package dependency and consume only exported entry points.
- Use versioned runtime protocols for optional extension integrations.
- Do not create a package without a concrete consumer and independent ownership boundary.
- Do not combine structural migrations with runtime behavior changes or broad formatting.

## Changesets

Add a changeset for public behavior, API, protocol, or consumer-affecting dependency changes. Private workspace scaffolding and documentation-only changes do not require a release changeset.
