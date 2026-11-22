# Cloud bidirectional smoke test

Use an explicitly authorized test Endpoint and one new unique nonce. Send at most once in each direction.

Record separately:

- original Message ID and audit sequence;
- persistence disposition (`CREATED`, `REPLAYED`, or unknown);
- exact payload read and nonce match;
- reply association found from the original Message ID, when `ce_find_replies` is registered;
- ACK receipt based on exact read metadata;
- Tunnel/MCP observations;
- client notification and Desktop wake observations.

Stop without retry when any send result is unknown. Do not read or ACK unrelated messages. Transport success, MCP persistence, client notification, Desktop wake, payload read, ACK, and business completion are separate verdicts. Cloud storage success alone does not prove a client was notified or awakened.
