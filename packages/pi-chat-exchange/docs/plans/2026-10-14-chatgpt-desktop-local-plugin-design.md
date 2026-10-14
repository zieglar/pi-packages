# ChatGPT Desktop Local Plugin Design

## Goal

Package the existing `mcp-stdio` entrypoint as an installable ChatGPT Desktop
local plugin without changing protocol, storage, endpoint authority, or MCP tool
behavior.

## Chosen approach

Use the portable Agent Plugins 1.0 layout. Version-controlled plugin sources
contain only manifests, a redacted operator configuration template, packaging
metadata, and documentation. A deterministic packaging script builds the
existing package, copies its compiled runtime plus production dependencies into
an ignored staging directory, validates the archive contents, and emits a ZIP.

This is preferred over a wrapper that points back into the repository because
an installed plugin must remain runnable from ChatGPT Desktop's plugin cache.
It is also preferred over duplicating MCP source because the existing
`src/bin/mcp-stdio.ts` remains the single implementation and authority boundary.

## Package shape

```text
pi-chat-exchange/
  plugin.json
  mcp.json
  config/binding.example.json
  server/launch.mjs
  server/dist/**
  server/node_modules/**
  server/package.json
  README.md
```

`mcp.json` launches `node ${PLUGIN_ROOT}/server/launch.mjs`. The launcher passes
the fixed operator-owned path `~/.config/pi-chat-exchange/mcp-binding.json` to
the existing entrypoint. The package never contains a
live store path, endpoint identity, recipient identity, capability, token, or
other secret. Users copy the template outside the installed plugin cache and
replace placeholders locally.

The launcher accepts a normalized absolute `--config` only for operator-run
diagnostics and automated package verification; the shipped `mcp.json` does not
provide this override.

The build also emits a local marketplace containing the packaged plugin so the
Desktop app can discover and install the self-contained artifact without a
public submission or network tunnel.

## Safety boundaries

- No edits under `src/protocol`, `src/core`, `src/storage`, `src/host`, or
  `src/control`.
- The existing absolute-path and strict-schema validation remains authoritative.
- The plugin does not read identity or configuration from environment variables.
- Package validation rejects symlinks, secret-shaped content, development files,
  and unexpected top-level entries.
- `stdout` remains reserved for MCP frames; startup diagnostics remain on
  `stderr`.

## Verification

Automated tests first prove the package is absent or invalid, then verify the
portable manifests, redacted template, staged server entrypoint, dependency
closure, ZIP layout, tool discovery, and a harmless `ping`. Existing targeted
stdio tests and the package's contract/type/build/test checks run afterward.

Actual installation in ChatGPT Desktop is a separate manual acceptance step.
Local automated verification does not claim that the Desktop UI loaded the
plugin.

