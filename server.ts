#!/usr/bin/env bun
/**
 * agentmesh MCP server
 *
 * Spawned as a stdio MCP server (one per Claude Code session).
 * Connects to the agentmesh broker for agent discovery, messaging, and topic pub/sub.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Configuration:
 *   AGENTMESH_BROKER_URL  — broker URL (default: http://127.0.0.1:7899)
 *   AGENTMESH_AGENT_NAME  — this agent's display name (default: "claude-code")
 *   AGENTMESH_CAPABILITIES — comma-separated capabilities (default: "")
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentId,
  Agent,
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";

// --- Configuration ---

const BROKER_URL = process.env.AGENTMESH_BROKER_URL ?? "http://127.0.0.1:7899";
const AGENT_NAME = process.env.AGENTMESH_AGENT_NAME ?? "claude-code";
const CAPABILITIES = (process.env.AGENTMESH_CAPABILITIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// --- State ---

let myId: AgentId | null = null;
let myToken: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (myToken) headers["Authorization"] = `Bearer ${myToken}`;

  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Utility ---

function log(msg: string) {
  console.error(`[agentmesh] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") return tty;
    }
  } catch {
    // ignore
  }
  return null;
}

// --- MCP Server ---

const mcp = new Server(
  { name: "agentmesh", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the agentmesh network. Other agents (Claude Code, OpenClaw, Hermes, custom) can see you and send you messages.

IMPORTANT: When you receive a <channel source="agentmesh" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply using send_message, then resume your work. Treat incoming messages like a coworker tapping you on the shoulder.

Read the from_id, from_agent_name, from_summary, and topic attributes to understand who sent the message and on what topic.

Available tools:
- list_agents: Discover other agents on the mesh (filter by scope, agent_type, capabilities)
- send_message: Send a direct message to an agent by ID
- broadcast: Publish a message to a named topic (all subscribers receive it)
- subscribe: Subscribe to a named topic
- unsubscribe: Unsubscribe from a topic
- set_summary: Set a 1-2 sentence summary of what you're working on
- check_messages: Manually check for new messages (fallback if channel push is unavailable)

When you start, proactively call set_summary to describe what you're working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_agents",
    description:
      "List agents registered on the agentmesh. Supports filtering by scope, agent_type, or capabilities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description: '"machine" = all agents on this host. "directory" = same cwd. "repo" = same git repo.',
        },
        agent_type: {
          type: "string" as const,
          enum: ["claude-code", "openclaw", "hermes", "custom"],
          description: "Filter to a specific agent type (optional)",
        },
        capabilities: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Filter to agents that have all of these capabilities (optional)",
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a direct message to another agent by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The agent ID to send to (from list_agents)",
        },
        message: {
          type: "string" as const,
          description: "The message text",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "broadcast",
    description: "Publish a message to a named topic. All agents subscribed to that topic receive it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string" as const,
          description: 'Topic name (e.g. "deploys", "alerts", "code-review")',
        },
        message: {
          type: "string" as const,
          description: "The message text",
        },
      },
      required: ["topic", "message"],
    },
  },
  {
    name: "subscribe",
    description: "Subscribe to a named topic to receive broadcast messages sent to it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string" as const,
          description: "Topic name to subscribe to",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "unsubscribe",
    description: "Unsubscribe from a named topic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string" as const,
          description: "Topic name to unsubscribe from",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "set_summary",
    description: "Set a brief summary of what you are working on. Visible to other agents via list_agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description: "Manually check for new messages. Fallback if channel push is not available.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_agents": {
      const { scope, agent_type, capabilities } = args as {
        scope: "machine" | "directory" | "repo";
        agent_type?: string;
        capabilities?: string[];
      };
      try {
        const agents = await brokerFetch<Agent[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
          agent_type,
          capabilities,
        });

        if (agents.length === 0) {
          return { content: [{ type: "text" as const, text: `No agents found (scope: ${scope}).` }] };
        }

        const lines = agents.map((a) => {
          const parts = [
            `ID: ${a.id}`,
            `Type: ${a.agent_type} — ${a.agent_name}`,
          ];
          if (a.capabilities?.length) parts.push(`Capabilities: ${a.capabilities.join(", ")}`);
          if (a.summary) parts.push(`Summary: ${a.summary}`);
          parts.push(`Host: ${a.hostname}`);
          if (a.cwd) parts.push(`CWD: ${a.cwd}`);
          parts.push(`Last seen: ${a.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [{
            type: "text" as const,
            text: `Found ${agents.length} agent(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error listing agents: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Message sent to ${to_id}` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "broadcast": {
      const { topic, message } = args as { topic: string; message: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; delivered_to?: string[]; error?: string }>("/broadcast", {
          from_id: myId,
          topic,
          text: message,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Broadcast failed: ${result.error}` }], isError: true };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Broadcast to topic "${topic}" — ${result.delivered_to?.length ?? 0} recipient(s)`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "subscribe": {
      const { topic } = args as { topic: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        await brokerFetch("/subscribe", { id: myId, topic });
        return { content: [{ type: "text" as const, text: `Subscribed to topic "${topic}"` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "unsubscribe": {
      const { topic } = args as { topic: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        await brokerFetch("/unsubscribe", { id: myId, topic });
        return { content: [{ type: "text" as const, text: `Unsubscribed from topic "${topic}"` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No new messages." }] };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id}${m.topic ? ` [${m.topic}]` : ""} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [{
            type: "text" as const,
            text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      let fromAgentName = "";
      let fromSummary = "";
      let fromCwd = "";
      try {
        const agents = await brokerFetch<Agent[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = agents.find((a) => a.id === msg.from_id);
        if (sender) {
          fromAgentName = sender.agent_name;
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        // Non-critical
      }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_agent_name: fromAgentName,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            topic: msg.topic ?? null,
            sent_at: msg.sent_at,
          },
        },
      });

      log(`Pushed message from ${msg.from_id}${msg.topic ? ` [${msg.topic}]` : ""}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Verify broker is reachable
  if (!(await isBrokerAlive())) {
    throw new Error(`Cannot reach agentmesh broker at ${BROKER_URL}. Is it running?`);
  }
  log(`Broker reachable at ${BROKER_URL}`);

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // 3. Register
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    hostname: require("os").hostname(),
    summary: "",
    agent_type: "claude-code",
    agent_name: AGENT_NAME,
    capabilities: CAPABILITIES,
    transport: { type: "channel" },
  });
  myId = reg.id;
  myToken = reg.token;
  log(`Registered as ${AGENT_NAME} (${myId})`);

  // 4. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 5. Poll for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 6. Heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 7. Cleanup
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
