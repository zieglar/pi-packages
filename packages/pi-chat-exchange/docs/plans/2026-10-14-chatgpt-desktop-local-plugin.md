# ChatGPT Desktop Local Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce a validated, installable ChatGPT Desktop local plugin ZIP that reuses the existing endpoint-bound stdio MCP server.

**Architecture:** Keep the existing MCP server unchanged and add a portable Agent Plugins package plus a deterministic packager. The packager builds and vendors only the compiled server and production dependency closure; operator binding configuration remains external and is represented only by a redacted template.

**Tech Stack:** TypeScript, Node.js 24, pnpm, Vitest, Agent Plugins 1.0 manifests, MCP stdio.

---

### Task 1: Lock the portable package contract with failing tests

**Files:**
- Create: `test/plugin/local-plugin-package.test.ts`
- Create later: `plugin/pi-chat-exchange/plugin.json`
- Create later: `plugin/pi-chat-exchange/mcp.json`
- Create later: `plugin/pi-chat-exchange/config/binding.example.json`

**Step 1:** Write tests that require the portable schemas, stable identity,
`${PLUGIN_ROOT}` stdio launcher, fixed external operator config location, four
expected tool names in documentation, and no credential-shaped strings.

**Step 2:** Run `pnpm vitest run test/plugin/local-plugin-package.test.ts`.

**Expected:** FAIL because the plugin directory does not exist.

**Step 3:** Add the minimum manifests, redacted template, and plugin README.

**Step 4:** Re-run the targeted test.

**Expected:** PASS.

### Task 2: Add a deterministic package builder

**Files:**
- Create: `scripts/package-local-plugin.mjs`
- Modify: `package.json`
- Modify: `test/plugin/local-plugin-package.test.ts`
- Create: `.gitignore` entries for generated plugin staging and archives if needed.

**Step 1:** Extend the test to invoke the packager and assert the staged package
contains the compiled entrypoint, runtime package metadata, production
dependencies, and no symlinks, source tests, live configuration, or secrets.

**Step 2:** Run the targeted test and confirm it fails because no packager exists.

**Step 3:** Implement the smallest packager using argument-vector child process
calls and filesystem APIs, not shell interpolation. Build the existing package,
materialize production dependencies, copy the portable files, inspect the tree,
and create a ZIP outside the plugin root.

**Step 4:** Re-run the targeted test and confirm it passes.

### Task 3: Verify the packaged stdio server

**Files:**
- Modify: `test/plugin/local-plugin-package.test.ts`

**Step 1:** Add a packaged-artifact test that starts the staged stdio entrypoint,
initializes MCP, lists tools, confirms `ping`, `ce_send`, `ce_inbox_list`, and
`ce_read_payload`, invokes harmless `ping`, and shuts down cleanly.

**Step 2:** Run the test against a deliberately missing staged package and confirm
the expected failure.

**Step 3:** Build the artifact through the packager and re-run the test.

**Expected:** PASS with four tools discovered and `ping` returning reachable.

### Task 4: Replace stale installation guidance

**Files:**
- Modify: `docs/chatgpt-installation.md`
- Modify: `docs/phase-0-evidence.md`
- Modify: `README.md`

**Step 1:** Update only the obsolete transport/package claims using current
official OpenAI documentation. Document local marketplace/manual Desktop install,
the external binding-config copy step, plugin restart/cache behavior, and the
manual end-to-end acceptance flow.

**Step 2:** Clearly label Desktop installation and real ChatGPT invocation as
`NOT_RUN` until performed by the user.

### Task 5: Final verification and review

**Files:**
- Review all changed files.

**Step 1:** Run the package-specific test.

**Step 2:** Run existing `test/bin/stdio-messaging.test.ts`.

**Step 3:** Run `pnpm run verify`.

**Step 4:** Run the package command and inspect the ZIP member list for a single
top-level `pi-chat-exchange/` directory and no sensitive or unrelated files.

**Step 5:** Inspect `git diff --check`, `git diff --stat`, and `git status`; verify
the pre-existing untracked `mise.toml` is untouched and no core authority files
changed.

**Step 6:** Do not commit or push without separate authorization.

