# ChatGPT Installation — pi-handoff `ping` smoke (manual user steps)

Pi cannot perform these steps for you: they require your OpenAI account,
browser interaction, and a runtime API key. Follow them in order; the final
step is the real acceptance test. Estimated time: ~10 minutes.

Prerequisites: this repo built (`pnpm run build` in `packages/pi-handoff`),
`node` on PATH, and a ChatGPT account with permission to create custom MCP
servers (workspace policy may restrict this).

## 1. Create the Secure MCP Tunnel

1. Open <https://platform.openai.com/settings/organization/tunnels> and
   create a tunnel. Note the `tunnel_id`.
   - Tunnel permissions are organization-level: you need Tunnels **Read** +
     **Use** (create requires **Manage**). Ask your org owner/RBAC admin if
     the page shows "Tunnels access required".
2. Download `tunnel-client` from
   <https://github.com/openai/tunnel-client/releases/latest>.
3. Create a runtime API key for the control plane and export it:

   ```bash
   export CONTROL_PLANE_API_KEY="sk-..."
   ```

4. Initialize and validate a profile pointing at the pi-handoff stdio server:

   ```bash
   tunnel-client init \
     --sample sample_mcp_stdio_local \
     --profile pi-handoff \
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
     --mcp-command "node $HOME/Code/pi-packages/packages/pi-handoff/dist/bin/mcp-stdio.js"

   tunnel-client doctor --profile pi-handoff --explain
   ```

5. Run the client and keep it running:

   ```bash
   tunnel-client run --profile pi-handoff
   ```

## 2. Create and install the personal plugin

1. In ChatGPT, open <https://chatgpt.com/plugins>, select the plus button,
   then **Create custom MCP server**.
2. Name it `pi-handoff`. Under **Connection**, select **Tunnel** and pick the
   tunnel created above (or paste its `tunnel_id`).
3. Authentication: **No authentication** (the tunnel itself is the access
   boundary; do not put API keys in this package).
4. Review the risk warning, select **I understand and want to continue**, then
   **Create as a plugin**.
5. Open <https://chatgpt.com/plugins?view=personal>, open the plugin, and
   install it with the plus button.

## 3. Invoke `ping` (the acceptance test)

1. On the ChatGPT homepage, switch the tab from **Chat** to **Work**.
2. Start a new Work chat. Type `@` in the prompt box and select **pi-handoff**.
3. Ask: *"Use the pi-handoff ping tool and show me the JSON result."*
4. Expected result — a JSON object exactly like:

   ```json
   {
     "service": "pi-handoff",
     "protocolVersion": 1,
     "host": "darwin 25.0.0",
     "status": "reachable"
   }
   ```

If ChatGPT cannot connect: verify `tunnel-client run` is healthy (the loopback
admin UI at `/ui`, plus `/healthz` and `/readyz`), that the tunnel is
associated with the ChatGPT workspace (not only the Platform organization),
and that the tunnel shows `tunnel-client` connected in Platform settings.

## Notes

- Personal custom MCP servers live only in your account; nothing is
  published or shared.
- Do not use a public HTTPS forwarding service in place of the tunnel for
  anything but a throwaway test — the broker phase must not expose an
  unauthenticated local control surface to the internet.
