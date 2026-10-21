---
"@zieglar/pi-chat-exchange": patch
---

Add the default-disabled `ce_ack` MCP tool using the existing Session-authorized delivery ACK receipt storage. The host supplies all authority fields; equivalent calls replay the original receipt. ACK records a recipient reception statement, not proof of delivery, reading, processing, or task completion. BUSY rollback and uncertain outcomes do not grant retry permission.

This changeset records the public behavior change only. It does not authorize publication, installation, versioning or tagging of the private package, or real ChatGPT dogfood.
