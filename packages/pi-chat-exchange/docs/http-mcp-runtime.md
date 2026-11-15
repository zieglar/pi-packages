# Local HTTP MCP runtime

The MCP entrypoint also supports a local Streamable HTTP transport. It uses the same binding configuration, endpoint ownership, admission policy, and tools as stdio:

```sh
node dist/bin/mcp-stdio.js --config /absolute/path/binding.json --http-socket /absolute/private-directory/mcp.sock
```

The socket directory must already exist, be owned by the effective user, and grant no group or other permissions (for example, mode `0700`). The socket is created with mode `0600`. The endpoint accepts only `POST /mcp`, the `Host: localhost` header, and requests without an `Origin` header. Any process running as the same user that can access the socket can use the bound MCP authority; this is an OS-user boundary, not per-client authentication. Do not expose or proxy the socket to untrusted clients.
The socket directory path must be canonical and every ancestor must be trusted: owned by the runtime user or root, without group/other write access, except for root-owned sticky directories. On macOS, granting ACLs on any directory in that chain are refused. This prevents another user from replacing the entire private directory through a writable parent.

The CE background manager does not yet authorize HTTP profiles: it refuses to start them until the actual Tunnel connection can be bound to the authorized Runtime identity. The existing Homebrew launcher remains stdio-only.

Tunnel Client 0.0.20 supports a logical HTTP URL dialed through a Unix socket. In an independently managed tunnel profile, a channel binding can use:

```yaml
mcp:
  server_urls:
    - channel: main
      url: http://localhost/mcp
      unix_socket: /absolute/private-directory/mcp.sock
```

Do not run an HTTP runtime and a stdio runtime for the same endpoint at the same time: both require the existing exclusive Owner. A graceful SIGTERM or SIGINT stops the HTTP listener, drains bound work, releases ownership and detaches the Session. Following a crash, inspect the existing Owner and socket state before recovery; this transport does not take over or clear them. The runtime does not automatically replay requests with unknown delivery results. Callers must determine the outcome using the existing messaging semantics before retrying.

For a persistent user deployment, run the CE runtime under its own user launchd job, separate from the Tunnel job, with an operator-created private socket directory and explicit executable and binding paths. A job without automatic restart avoids blindly restarting after an unknown failure or stale Owner. Normal maintenance can stop and start the CE job independently, after checking cleanup; changing a live Tunnel profile or installing a job requires the separately authorized deployment procedure. This is a proposed local operating configuration, not evidence of Cloud qualification.
