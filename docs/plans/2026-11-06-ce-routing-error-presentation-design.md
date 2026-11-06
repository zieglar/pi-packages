# CE Routing Guidance and Read-Refusal Presentation Design

**Goal:** Prevent stale ChatGPT recipient selection and present `MESSAGE_READ_REJECTED` as an eligibility refusal rather than a Host outage, without changing CE authority or multi-Session isolation.

**Evidence:** CE #103 and #107 were explicitly sent by the caller to `pi/session-e091…`; the active receiver was `pi/session-795…`, so its denial was correct. CE #108 used the exact current `795…` recipient and its authorized payload read succeeded. The repository contains no hardcoded `e091…` recipient and CE has no latest-Session inference or automatic forwarding. Both Pi and MCP adapters currently print the outer `CE_HOST_UNAVAILABLE` code even when the fixed reason is `MESSAGE_READ_REJECTED`.

## Approved approach

1. Keep `ce_send.to` explicit. Strengthen the MCP tool/schema guidance and ChatGPT usage documentation: in live mode, refresh exact currently authorized targets with `ce_endpoints` before choosing a recipient; do not reuse an Endpoint from an earlier conversation. If the intended target is ambiguous, require explicit user selection. `CREATED` remains local Message evidence, not receiver-read or task-completion evidence.
2. Preserve Host, Protocol, Store, and structured tool results unchanged. In the Pi and MCP presentation functions only, when the sanitized reason is exactly `MESSAGE_READ_REJECTED`, display a fixed eligibility-refusal message that makes no Host-connectivity claim. Do not expose the requested message's metadata, recipient, Exchange, payload, or underlying error text.
3. Add focused regression coverage for MCP descriptor guidance, sanitized MCP read-refusal presentation, and real Pi cross-Endpoint refusal versus correct-recipient success. Existing Host tests continue to pin `CE_HOST_UNAVAILABLE` plus `MESSAGE_READ_REJECTED` at that lower boundary.

## Rejected alternatives

- Automatically infer the newest/current recipient or forward a message across Endpoints: rejected because it cannot prove user intent and violates Session isolation.
- Introduce a new Host error code or alter the Storage refusal: unnecessary public/protocol change; the existing fixed reason is sufficient for accurate adapter presentation.
- Documentation only: leaves the actual misleading tool output unchanged.

## Validation and deployment boundary

Run focused MCP and Pi extension tests, package build/typecheck, and relevant contract checks. A local commit is authorized. No Push, Merge, Release, installation, shared Tunnel restart, live permission/configuration change, cross-Endpoint read, or Hook/Ovis automation change is authorized. Updated tool guidance and presentation remain local-only until a separately authorized build/install/deployment; the currently running production adapter is not changed by this work.
