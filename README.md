# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)               |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. By default everything is localhost-only, but cross-machine messaging is supported (see below).

## Cross-machine setup

By default, the broker only serves localhost. To let Claude Code instances on different machines discover each other and exchange messages, point the remote machines at a shared broker.

### Architecture

```
  Server (broker host)                   Mac (remote client)
  ┌──────────────────────┐               ┌──────────────────────┐
  │ broker.ts            │               │ server.ts            │
  │ 0.0.0.0:7899         │◄──────────────│ BROKER_URL=          │
  │ ~/.claude-peers.db   │               │  http://SERVER:7899  │
  └──────┬───────────────┘               └──────┬───────────────┘
         │                                      │
    MCP server A                           MCP server B
    (local)                                (remote)
         │                                      │
    Claude A                               Claude B
```

### 1. Ensure the broker is reachable

The broker binds `0.0.0.0:7899` by default, so it accepts connections from any interface. Make sure port 7899 is open between the machines (firewall, security group, etc.).

### 2. On the remote machine

Clone and install as usual, then register the MCP server with `CLAUDE_PEERS_BROKER_URL` pointing at the broker host:

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp && bun install
```

Add to your Claude Code MCP config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "claude-peers": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/claude-peers-mcp/server.ts"],
      "env": {
        "CLAUDE_PEERS_BROKER_URL": "http://BROKER_HOST_IP:7899"
      }
    }
  }
}
```

Replace `BROKER_HOST_IP` with the server's LAN or public IP.

### 3. Verify

From either machine:

```
> list peers

# Should show peers from both machines with their hostname, CWD, and summary
```

### Gotchas

- **`to_id` not `to`:** The `send_message` tool parameter is `to_id`. Using `to` silently sends `undefined` and the broker returns "Peer undefined not found."
- **Stale remote peers:** The broker can't verify remote PIDs with `kill(pid, 0)`, so remote peers expire by heartbeat timeout (60s) instead. If a remote peer appears stale, it will be cleaned up automatically.
- **`set_summary` on startup:** Always call `set_summary` at the start of a session so other peers have context when they discover you.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default              | Description                           |
| -------------------- | -------------------- | ------------------------------------- |
| `CLAUDE_PEERS_PORT`       | `7899`               | Broker port                                          |
| `CLAUDE_PEERS_DB`         | `~/.claude-peers.db` | SQLite database path                                 |
| `CLAUDE_PEERS_BROKER_URL` | `http://127.0.0.1:7899` | Broker URL — set on remote machines for cross-machine use |
| `CLAUDE_PEERS_BIND`       | `0.0.0.0`           | Broker bind address                                  |
| `OPENAI_API_KEY`          | —                    | Enables auto-summary via gpt-5.4-nano                |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
