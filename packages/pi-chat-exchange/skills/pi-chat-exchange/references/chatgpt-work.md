# ChatGPT / Work

1. Inspect registered tools; call `ce_help` when available.
2. When `ce_endpoints` is registered, obtain a fresh authorized target for this conversation. Do not reuse historical Endpoint IDs.
3. Send with `ce_send` and one stable idempotency key. Do not retry `UNKNOWN` or `DELIVERY_UNKNOWN` without durable reconciliation.
4. Query an associated result with the original Message ID through `ce_find_replies` only when that tool is registered.
5. To receive, use `ce_inbox_list`, select the intended Message ID, then use `ce_read_payload`. ACK with `ce_ack` only when registered and only with the exact digest, length, and audit sequence returned by the read.
6. Use `ce_task_owner` only when registered. Registered TaskOwner and the current ChatGPT conversation are not interchangeable.

`CHECK_ONLY` or metadata visibility does not grant payload-read authority. A Desktop notification or wake does not prove message persistence, payload read, ACK, or task completion.
