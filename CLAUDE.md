---
description: Use Bun instead of Node.js. This is the agentmesh MCP adapter.
globs: "*.ts, package.json"
alwaysApply: false
---

# agentmesh-mcp

MCP server adapter for the agentmesh universal cross-agent messaging broker.

## Architecture

- `server.ts` — MCP stdio server for Claude Code instances. Registers with the agentmesh broker, exposes tools, pushes inbound messages as channel notifications.
- `shared/types.ts` — TypeScript types for the broker API.

The broker itself lives in a separate repo (SlanchaAi/agentmesh). This adapter is the Claude Code-specific MCP wrapper around it.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `AGENTMESH_BROKER_URL` | `http://127.0.0.1:7899` | Broker URL (set to remote host for cross-machine) |
| `AGENTMESH_AGENT_NAME` | `claude-code` | Display name for this agent |
| `AGENTMESH_CAPABILITIES` | `` | Comma-separated capabilities list |

## Session startup

Always call `set_summary` at the start of each session so other agents know your context.

## Gotchas

- `send_message` takes `to_id` (not `to`)
- The broker must be running before this server starts — it does NOT auto-launch the broker (unlike claude-peers)
- Use `list_agents` (not `list_peers`) for agent discovery

## Running

```bash
bun install
bun server.ts
```

Or add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "agentmesh": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/agentmesh-mcp/server.ts"],
      "env": {
        "AGENTMESH_BROKER_URL": "http://SERVER_IP:7899"
      }
    }
  }
}
```
