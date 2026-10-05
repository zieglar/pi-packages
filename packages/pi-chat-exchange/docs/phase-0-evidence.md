# Phase 0 Evidence — pi-handoff platform audit

> **ARCHIVAL (2026-10-06, PH-0002):** findings preserved unchanged as
> historical evidence (ChatGPT plugin/tunnel/Work-chat support, public
> owning-session Pi APIs, RPC rejection, Moshi/Herdr not required, real
> ChatGPT acceptance NOT_RUN). Project renamed to pi-chat-exchange; current
> contracts: [protocol-v2.md](protocol-v2.md); source-reuse conclusions:
> [source-reuse-audit.md](source-reuse-audit.md).

Date: 2026-10-05. Sources fetched and read in full on this date. Anything not
established by these sources is marked UNKNOWN.

## A. ChatGPT Desktop local Plugin/MCP

**Verdict: SUPPORTED** via the personal "custom MCP server" plugin path, with
Secure MCP Tunnel as the officially documented mechanism for reaching a
localhost/private MCP server. ChatGPT-side installation is manual UI work that
Pi cannot perform on the user's behalf; artifacts and instructions are prepared
in [chatgpt-installation.md](chatgpt-installation.md).

| Question | Answer | Source |
| --- | --- | --- |
| Can ChatGPT load a personal/local plugin? | **Yes.** `chatgpt.com/plugins` → plus → **Create custom MCP server** creates a personal plugin (no public submission needed); it appears in the personal plugins list and is installed from there. A separate local-marketplace mechanism exists for desktop-app testing (`~/.agents/plugins/marketplace.json`, requires desktop app restart). | developers.openai.com/plugins/quickstart, /plugins/deploy/connect-chatgpt, /plugins/build/plugins |
| Can a local MCP process be launched directly by the plugin? | **No direct localhost.** Connection methods are a public HTTPS endpoint (SSE or streaming HTTP, typically `/mcp`) **or** a Secure MCP Tunnel. A "development tunnel or another HTTPS forwarding service" also works for local testing. | developers.openai.com/plugins/deploy/connect-chatgpt, /api/docs/guides/custom-mcp-server |
| Is Secure MCP Tunnel required for localhost/private MCP? | **Yes**, it is the documented path. `tunnel-client` runs on the user's machine, long-polls OpenAI over outbound HTTPS, and forwards to a local **stdio command or HTTP MCP server URL**. It needs a `tunnel_id` (Platform → Settings → Tunnels), a runtime API key (`CONTROL_PLANE_API_KEY`), and Tunnels Read+Use permissions. | developers.openai.com/api/docs/guides/secure-mcp-tunnels, github.com/openai/tunnel-client |
| Usable in ordinary Chat or only Work? | **Work.** The quickstart explicitly switches the homepage tab from **Chat** to **Work** and starts a Work chat; plugin invocation is via `@` in the Work prompt box. Docs consistently describe plugin/MCP-event usage in "Work chats" (web and desktop). Ordinary Chat availability is therefore **NO per current docs** (UNKNOWN for future releases). | developers.openai.com/plugins/quickstart, /plugins/build/mcp-events |
| How is the plugin installed/registered? | Web UI: ChatGPT Plugins → Create custom MCP server → (Server URL or Tunnel) → "Create as a plugin" → install from personal plugins. Desktop: local marketplace file + app restart. | same as above |
| Manifest/configuration required? | For a personal custom MCP server: none beyond name/description/connection/auth. Packaging manifests (`plugin.json`, `.app.json`) are only needed for directory submission or marketplace distribution. | /plugins/build/plugins |
| MCP transports supported? | SSE and streaming HTTP (public endpoint); tunnel-client reaches **stdio or HTTP** upstreams. | /api/docs/guides/custom-mcp-server, /api/docs/guides/secure-mcp-tunnels |
| Write tools supported? | Yes. Tools without `readOnlyHint: true` are treated as write actions. | /api/docs/guides/custom-mcp-server |
| User confirmation for write tools? | Yes — write actions require confirmation by default; approve/deny can be remembered per conversation; `readOnlyHint` is honored. | /api/docs/guides/custom-mcp-server |

Implication for the smoke: `pi-handoff` serves MCP over **stdio** (works with
`tunnel-client --mcp-command`, zero open ports); `ping` carries
`readOnlyHint: true` so ChatGPT treats it as read-only.

## B. Pi runtime integration

**Verdict: SUPPORTED_PUBLICLY.** The preferred architecture — the *existing*
Pi session consumes handoffs through a Pi extension — is achievable with
documented public APIs in the installed Pi 0.86.1.

| Question | Answer | Source |
| --- | --- | --- |
| Programmatic prompt injection into the owning session? | **Yes.** `pi.sendUserMessage(content, options?)` sends an actual user message "as if typed by the user", always triggers a turn; when streaming, `deliverAs: "steer" \| "followUp"` queues it; `nextTurn` defers. | pi docs extensions.md — ExtensionAPI Methods |
| Relevant hooks / events? | `session_start` (reason: startup/reload/new/resume/fork), `agent_start`, `agent_end` (run messages), `agent_settled` (no further automatic continuation), `turn_start`/`turn_end` (message + toolResults), `message_*`. | extensions.md — Events |
| Session identity / custom entries? | `ctx.sessionManager.getSessionFile()`, `getEntries()`; `pi.appendEntry(customType, data?)` persists extension data (restorable on `session_start`); `ctx.cwd` for the workspace. | extensions.md — ExtensionContext / appendEntry |
| EventBus? | `pi.events` in extensions; `createEventBus()` for SDK hosts; extension-to-extension communication inside one Pi process. | sdk.md — Event Bus |
| RPC applicability? | **Not appropriate** for this architecture: `pi --mode rpc` is a separate headless session protocol. Using it would create a competing session alongside Moshi/Herdr — explicitly rejected by the handoff. | rpc.md |
| Extension loading? | `~/.pi/agent/extensions/*.ts` (global), `.pi/extensions` (project-local), `settings.json → extensions` paths, or pi packages. A future pi-handoff extension installs through these public locations. | extensions.md — Extension Locations |

No private Pi API is required for the frozen design. If a future phase needs
more than `sendUserMessage` + lifecycle events + appendEntry, that must be
reported as a gap rather than bridged with private APIs.

## C. Moshi / Herdr boundary

**Verdict: NOT_REQUIRED.** Moshi and Herdr remain UI/runtime hosts: they
already launch Pi with extension support, and the pi-handoff extension will run
inside those existing sessions. No source or API evidence requires direct
Moshi/Herdr integration for the handoff protocol.

## Stop-condition review

None of the handoff §18 stop conditions triggered:

- ChatGPT **does** support the assumed local MCP mechanism (via tunnel).
- Installation is manual but fully documented (no undocumented hacks).
- Public Pi APIs **can** inject into the existing session.
- The smoke requires no modification to production Pi/Moshi/Herdr.
- The repo worktree was clean at baseline; only intended files changed.
- No credentials are copied or exposed anywhere in this package.
- No private Pi APIs are used.

## Real ChatGPT acceptance

**NOT_RUN** — ChatGPT-side steps (tunnel creation, plugin creation/install,
Work-chat invocation) require the user's manual interaction and credentials.
This is expected and does not block Phase 1: the server-side path is proven by
protocol-level tests; the ChatGPT half is ready for the user to execute via
[chatgpt-installation.md](chatgpt-installation.md). Acceptance may be claimed
only after ChatGPT itself successfully invokes `ping`.
