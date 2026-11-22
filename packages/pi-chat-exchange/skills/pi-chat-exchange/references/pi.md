# Pi

Inspect the CE tools and commands actually loaded in the current Pi Session; names and capabilities may differ from the MCP surface. Use `ce_help` only if it is registered there.

- Bind or discover only an Endpoint authorized for the current Session.
- Send a result once with a stable idempotency key and preserve the original Message ID as the reply association when the loaded schema supports it.
- Receive metadata before reading an exact payload. `CHECK_ONLY` visibility is not business payload-read authority.
- ACK only from metadata returned by the exact successful read. ACK means received, not completed.
- A successful desktop prepare step does not prove CE send, Hook execution, Desktop wake, client read, or ACK.
- Stop on `UNKNOWN`, `CE_HOST_UNCERTAIN`, or `DELIVERY_UNKNOWN`; preserve evidence and reconcile instead of resending.

Do not infer unavailable tools from this document. Follow the current Pi command/tool descriptions and closed schemas.
