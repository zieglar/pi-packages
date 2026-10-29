[English](./2026-10-11-pi-integration-slice.md) | [简体中文](./2026-10-11-pi-integration-slice.zh-CN.md)

> Historical plan (2026-10-11). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# B3-P3B real two-process Pi runtime experiment

Date: 2026-10-11
Phase: CE-0002 B3-P3B
Prereq: `pnpm --dir packages/pi-chat-exchange run build` (the extension
imports the compiled host seam from `packages/pi-chat-exchange/dist`).

## Isolation rules

- A dedicated temporary HOME and working directory; no production `~/.pi`
  agent directory, credentials, sessions, or extension installation are
  touched.
- A dedicated temporary CE store directory (created by the extension on first
  use, including the host-secret artifact).
- The extension under test is copied into the temporary working directory's
  `.pi/extensions/ce-chat-exchange/` and imports the package `dist` via a
  relative path, so the copy is patched to point back at the repository
  checkout.

## Setup

```sh
REPO=/path/to/ce-checkout
TMP=$(mktemp -d /tmp/ce-p3b-smoke-XXXXXX)
mkdir -p "$TMP/home" "$TMP/work" "$TMP/store"
cp -r "$REPO/.pi/extensions/ce-chat-exchange" "$TMP/work/.pi-extensions-src"
mkdir -p "$TMP/work/.pi/extensions"
cp -r "$TMP/work/.pi-extensions-src" "$TMP/work/.pi/extensions/ce-chat-exchange"
# point the copied extension at this checkout's compiled seam
perl -pi -e "s{\\Q../../../packages/pi-chat-exchange\\E}{$REPO/packages/pi-chat-exchange}" \
  "$TMP/work/.pi/extensions/ce-chat-exchange/index.ts"

cat > "$TMP/allowlist.json" <<'JSON'
{
  "exchangeNamespace": "pi-local",
  "exchangeIdempotencyKey": "pi-local-exchange",
  "leaseTtlSeconds": 600,
  "sessions": {
    "ceA": { "endpointId": "local/sessionA" },
    "ceB": { "endpointId": "local/sessionB" }
  }
}
JSON
```

## Checks (record observed output; never infer)

1. **Extension loads, distinct identities.** In two terminals (or two
   sequential `pi -p` runs sharing `$TMP/store`):

   ```sh
   cd "$TMP/work"
   env HOME="$TMP/home" CE_STORE_DIR="$TMP/store" CE_ALLOWLIST="$TMP/allowlist.json" \
     pi --session-id ceA -p "Reply with exactly: ready-A"
   env HOME="$TMP/home" CE_STORE_DIR="$TMP/store" CE_ALLOWLIST="$TMP/allowlist.json" \
     pi --session-id ceB -p "Reply with exactly: ready-B"
   ```

   Evidence: the session files under `$TMP/home/.pi/agent/sessions/...` exist
   with distinct session headers (`"id": "ceA"` vs `"ceB"`), each contains a
   `ce-mapping` custom entry, and the two `sessionId` values are distinct
   `ses_…` ids.

2. **Authorized A send.** Ask A's model to call `ce_send` with
   `to: "local/sessionB"`, `text: "hello from A"`, `idempotencyKey: "smoke-1"`.
   Evidence: tool result shows `created` with a `msg_…` id; durable store has
   exactly one message row.

3. **Authorized B metadata read.** Ask B's model to call `ce_read` with the
   message id from step 2. Evidence: metadata (`from local/sessionA`, length
   12, sha256 digest) and **no payload text** in the result.

4. **Read authority cannot send / wrong recipient cannot read.** `ce_send`
   from B to A succeeds only with B's own authority (allowed — B holds a send
   capability); B reading a message addressed to A returns the opaque
   `MESSAGE_READ_REJECTED` refusal. Evidence: refusal text in the tool
   result.

5. **Expired ownership refuses.** Wait for the lease to expire (or use a
   short `leaseTtlSeconds`) and call `ce_send`; evidence:
   `CE_HOST_AUTHORITY_ABSENT`.

6. **Reload does not duplicate handlers.** In an interactive session run
   `/reload`, then `/ce-status`; evidence: exactly one binding notification
   and one clean status line (the runtime invalidates the old extension
   runner; the extension registers no timers or watchers).

7. **Restart does not silently reconstruct authority.** Re-run step 1 for
   `ceA` within the lease: the mapping is re-adopted and `ce-status` reports
   the same CE Session. After lease expiry, `ce-status` reports
   `registered=true` but operations refuse with `CE_HOST_AUTHORITY_ABSENT`.

8. **Cursor unchanged.** `SELECT count(*) FROM delivery_cursor;` → `0`
   before and after all steps.

9. **No credential leakage.** `grep -rE 'cap_[0-9a-f]{64}' "$TMP"` over
   session files, extension store directory text artifacts, and captured pi
   output returns nothing.

## Cleanup

```sh
rm -rf "$TMP"
```

## NOT_RUN policy

If any step cannot be performed safely in the isolated environment (for
example no model provider credential is available for `-p` tool-driving, or
tmux is unavailable for the interactive reload check), mark that step
NOT_RUN in the report. A mock or unit test is never substituted for a real
runtime claim.

## Observed results (2026-10-11, isolated env, pi 0.86.1 on Node 24.21.0)

Tool-driving runs used `zai-coding-cn/glm-5.3`; the interactive `/reload` check (step 6) used the default subscription model and required no inference (its evidence is extension/command-generated).

All steps executed in `/private/tmp/ce-p3b-smoke-*` environments with
`PI_CODING_AGENT_DIR` isolation; production `~/.pi` untouched. Model:
zai-coding-cn/glm-5.3 (anthropic/openai-codex providers were quota-limited).

1. Extension loaded in both processes; Pi headers `ceA`/`ceB`; CE sessions
   `ses_<SESSION_A>` / `ses_<SESSION_B>`;
   participants distinct; shared exchange `ho_<EXCHANGE>`.
2. A `ce_send` → `msg_<BEFORE_JOIN>` (CREATED).
3. B `ce_read` of that id refused `MESSAGE_READ_REJECTED`: the message
   predates B's join boundary — correct P3A semantics. Second send after B
   joined (`msg_<AFTER_JOIN>`) was read successfully: from
   `local/sessionA`, 13 bytes, metadata only, no payload text.
4. Sender reading the recipient's message and a nonexistent id both refused
   with the identical opaque `MESSAGE_READ_REJECTED`.
5. After lease expiry, the send refused truthfully with
   `CE_HOST_AUTHORITY_ABSENT (LEASE_EXPIRED)`; zero durable messages. Full
   history (env `/private/tmp/ce-p3b-expiry/`): the first two attempts
   (`exp-1`, `exp-2`, run with the extension copy that predated the
   startup-failure fix) surfaced the misleading `CE_HOST_NOT_REGISTERED`;
   that defect was fixed in the extension (failed `resume` now reports the
   startup failure verbatim) and the third attempt (`exp-3`, post-fix)
   produced the truthful `LEASE_EXPIRED` refusal recorded here.
6. `/reload` (interactive `ceE`, instrumented smoke copy only — the repo
   extension has no instrumentation). Durable artifacts:
   `/private/tmp/ce-p3b-smoke-<RUN>/evidence-reload/marker.log` recorded
   exactly `factory-run`, `session_start reason=startup`, `factory-run`,
   `session_start reason=reload` — one re-evaluation, no duplicated handlers;
   `4-status-after.txt` shows the post-reload `/ce-status` reporting the SAME
   CE session (`ses_<RELOAD_SESSION>`, lease ACTIVE). The reload
   re-adopted the mapping from the SessionManager's in-memory branch entries
   (`pi.appendEntry` survives `/reload` without a session file — no `ceE`
   session file exists, and the durable store shows exactly one binding and
   one ownership row). An earlier uninstrumented attempt of this step
   produced a contradictory transcript (extension not loaded due to a broken
   symlink; the model then hallucinated tool availability from session
   history) and was discarded in favour of this instrumented run.
7. Restart within lease resumed the SAME CE session (4 `ce-mapping` entries,
   identical session ids); post-expiry restart refused authority recovery.
8. `SELECT count(*) FROM delivery_cursor` = 0 before and after all steps.
9. `grep -rE 'cap_[0-9a-f]{64}'` over the entire smoke tree (session files,
   store artifacts, captured output): zero matches.

Runtime findings folded back into the implementation: (a) the adapter/host
requires Node 24.21.0 exactly — the pi shim runs the system Node unless
`PATH` is prefixed with the 24.21.0 bin dir; (b) a failed `resume` now
surfaces `CE_HOST_AUTHORITY_ABSENT` to tools instead of a misleading
not-registered refusal; (c) models may *claim* tool availability from
resumed-session history — only a real tool invocation is evidence.
