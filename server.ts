#!/usr/bin/env bun
/**
 * agentmesh MCP server v0.2.0
 *
 * MCP stdio adapter for Claude Code instances connecting to the agentmesh broker.
 * Uses WebSocket for instant push delivery, falls back to HTTP polling when WS unavailable.
 *
 * Configuration:
 *   AGENTMESH_BROKER_URL   — broker HTTP URL (default: http://127.0.0.1:7899)
 *   AGENTMESH_AGENT_NAME   — display name (default: "claude-code")
 *   AGENTMESH_CAPABILITIES — comma-separated capability list
 *   AGENTMESH_FLEET_ID     — fleet namespace (e.g. "production")
 *   AGENTMESH_DEVICE_ID    — device identifier within fleet
 *   AGENTMESH_LWT_TOPIC    — Last Will and Testament topic (e.g. "fleet/agents/status")
 *   AGENTMESH_LWT_MESSAGE  — LWT message payload (default: JSON with agent_id + offline)
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
  QoS,
  RegisterResponse,
  PeekMessagesResponse,
  Message,
  WsClientFrame,
  WsBrokerFrame,
} from "./shared/types.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BROKER_URL = process.env.AGENTMESH_BROKER_URL ?? "http://127.0.0.1:7899";
const BROKER_WS_URL = BROKER_URL.replace(/^http/, "ws") + "/ws";
const AGENT_NAME = process.env.AGENTMESH_AGENT_NAME ?? "claude-code";
const CAPABILITIES = (process.env.AGENTMESH_CAPABILITIES ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const FLEET_ID = process.env.AGENTMESH_FLEET_ID ?? undefined;
const DEVICE_ID = process.env.AGENTMESH_DEVICE_ID ?? undefined;
const LWT_TOPIC = process.env.AGENTMESH_LWT_TOPIC ?? undefined;
const HTTP_POLL_INTERVAL_MS = 2000;  // fallback polling when WS unavailable
const HEARTBEAT_INTERVAL_MS = 15_000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let myId: AgentId | null = null;
let myToken: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// Track message IDs pushed via WS/channel — don't re-push same message
const pushedMessageIds = new Set<number>();

// WS state
let ws: WebSocket | null = null;
let wsConnected = false;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Poll timer — active only when WS is unavailable
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Broker HTTP
// ---------------------------------------------------------------------------

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (myToken) headers["Authorization"] = `Bearer ${myToken}`;

  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Broker error (${path}): ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inbound message handler (shared by WS push and HTTP poll)
// ---------------------------------------------------------------------------

async function handleInboundMessage(msg: Message) {
  if (pushedMessageIds.has(msg.id)) return;

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
      fromAgentName = sender.agent_name ?? "";
      fromSummary = sender.summary;
      fromCwd = sender.cwd ?? "";
    }
  } catch {
    // Non-critical — proceed without sender context
  }

  try {
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
          qos: msg.qos,
          sent_at: msg.sent_at,
          fleet_id: FLEET_ID ?? null,
          device_id: DEVICE_ID ?? null,
        },
      },
    });
    pushedMessageIds.add(msg.id);
    log(`Pushed message ${msg.id} from ${msg.from_id}${msg.topic ? ` [${msg.topic}]` : ""}`);
  } catch {
    log(`Channel push failed for message ${msg.id} — will retry`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

function connectWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  try {
    ws = new WebSocket(BROKER_WS_URL);
  } catch {
    scheduleWsReconnect();
    return;
  }

  ws.onopen = () => {
    log("WS connected to broker");
    if (!myId || !myToken) return;

    const lwtMessage = LWT_TOPIC
      ? (process.env.AGENTMESH_LWT_MESSAGE ?? JSON.stringify({ agent_id: myId, agent_name: AGENT_NAME, status: "offline" }))
      : undefined;

    const frame: WsClientFrame = {
      type: "CONNECT",
      agent_id: myId,
      token: myToken,
      ...(LWT_TOPIC && lwtMessage ? {
        lwt: { topic: LWT_TOPIC, message: lwtMessage, qos: 1, retain: true }
      } : {}),
    };
    ws!.send(JSON.stringify(frame));
  };

  ws.onmessage = async (event) => {
    try {
      const frame = JSON.parse(event.data as string) as WsBrokerFrame;

      if (frame.type === "CONNECTED") {
        wsConnected = true;
        wsReconnectDelay = WS_RECONNECT_BASE_MS;
        log(`WS authenticated as ${frame.agent_id}`);
        stopPolling(); // WS push is now active — no need to poll

        // Announce online if LWT topic configured
        if (LWT_TOPIC && myId) {
          brokerFetch("/broadcast", {
            from_id: myId,
            topic: LWT_TOPIC,
            text: JSON.stringify({ agent_id: myId, agent_name: AGENT_NAME, status: "online" }),
            qos: 1,
            retain: true,
          }).catch(() => {});
        }

      } else if (frame.type === "MESSAGE") {
        const msg = frame.message;
        await handleInboundMessage(msg);
        // ACK for QoS ≥ 1 — confirm receipt to broker
        if (msg.qos >= 1 && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ACK", message_id: msg.id } satisfies WsClientFrame));
          pushedMessageIds.delete(msg.id); // message fully acked, clean up tracking
        }

      } else if (frame.type === "PONG") {
        // keepalive confirmed
      } else if (frame.type === "ERROR") {
        log(`Broker WS error: ${frame.code} — ${frame.message}`);
        if (frame.code === "UNAUTHORIZED") {
          ws?.close();
        }
      }
    } catch (e) {
      log(`WS message parse error: ${e}`);
    }
  };

  ws.onclose = (event) => {
    ws = null;
    wsConnected = false;
    if (event.code !== 1000) {
      // Unexpected close — start HTTP polling as fallback
      startPolling();
      scheduleWsReconnect();
    }
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

function scheduleWsReconnect() {
  log(`WS reconnecting in ${wsReconnectDelay}ms`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
    connectWebSocket();
  }, wsReconnectDelay);
}

// ---------------------------------------------------------------------------
// HTTP poll fallback (active when WS unavailable)
// ---------------------------------------------------------------------------

async function pollAndPushMessages() {
  if (!myId || wsConnected) return;

  try {
    const result = await brokerFetch<PeekMessagesResponse>("/peek-messages", { id: myId });
    for (const msg of result.messages) {
      await handleInboundMessage(msg);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function startPolling() {
  if (pollTimer || wsConnected) return;
  pollTimer = setInterval(pollAndPushMessages, HTTP_POLL_INTERVAL_MS);
  log("HTTP polling started (WS fallback)");
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  log("HTTP polling stopped (WS active)");
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.error(`[agentmesh] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd, stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    if (await proc.exited === 0) return text.trim();
  } catch {}
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
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "agentmesh", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the agentmesh network — a private mesh for heterogeneous agents (Claude Code, OpenClaw, Hermes, custom) across a fleet of devices.

IMPORTANT: When you receive a <channel source="agentmesh" ...> message, RESPOND IMMEDIATELY. Pause your current task, reply using send_message, then resume. Treat it like a coworker tapping you on the shoulder.

Read from_id, from_agent_name, from_summary, topic, fleet_id, device_id from the message meta.

Available tools:
- list_agents: Discover agents (filter by scope, fleet, device, agent_type, capabilities, online_only)
- send_message: Send a direct message to an agent by ID
- broadcast: Publish to a topic (all subscribers receive it; supports MQTT wildcards on subscribe)
- subscribe: Subscribe to a topic (+ = one level, # = all levels)
- unsubscribe: Unsubscribe from a topic
- set_summary: Describe what you're working on (visible to all peers)
- check_messages: Reliably retrieve pending messages (ACKs on return — use this if channel push seems slow)
- get_dead_letters: Retrieve messages that could not be delivered after max retries

Topic conventions:
  {fleet}/{device}/{name}  — e.g. "prod/edge-42/status"
  +  — matches any single segment
  #  — matches all remaining segments (must be last)

Call set_summary at session start. If LWT is configured, an "offline" message is published automatically on disconnect.`,
  }
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_agents",
    description: "Discover agents on the mesh. Filter by scope, fleet, device, agent_type, capabilities, or online status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo", "fleet", "device"],
          description: '"machine" = all on this host | "fleet" = same fleet_id | "device" = same device_id | "repo"/"directory" = git/cwd scope',
        },
        fleet_id: { type: "string" as const, description: "Filter by fleet" },
        device_id: { type: "string" as const, description: "Filter by device" },
        agent_type: { type: "string" as const, enum: ["claude-code", "openclaw", "hermes", "custom"] },
        capabilities: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Filter to agents with ALL these capabilities",
        },
        online_only: { type: "boolean" as const, description: "Only return WebSocket-connected agents" },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a direct message to an agent by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "Agent ID (from list_agents)" },
        message: { type: "string" as const },
        qos: { type: "number" as const, description: "0=fire-and-forget, 1=at-least-once (default)" },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "broadcast",
    description: "Publish a message to a topic. All agents subscribed (including wildcard patterns) receive it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string" as const, description: 'e.g. "prod/edge-42/alerts" or "fleet/all/shutdown"' },
        message: { type: "string" as const },
        qos: { type: "number" as const, description: "0 or 1 (default 1)" },
        retain: { type: "boolean" as const, description: "Store as retained — new subscribers receive it immediately" },
      },
      required: ["topic", "message"],
    },
  },
  {
    name: "subscribe",
    description: "Subscribe to a topic. Supports MQTT wildcards: + (one level) and # (all remaining levels).",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string" as const, description: 'e.g. "prod/+/alerts" or "fleet/#"' },
      },
      required: ["topic"],
    },
  },
  {
    name: "unsubscribe",
    description: "Unsubscribe from a topic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string" as const },
      },
      required: ["topic"],
    },
  },
  {
    name: "set_summary",
    description: "Set a 1-2 sentence summary of what you are doing. Visible to all peers via list_agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description: "Reliably retrieve pending messages and ACK them. Use this if you suspect channel push is delayed.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_dead_letters",
    description: "Retrieve messages that failed delivery after max retries or TTL expiry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" as const, description: "Max results (default 50)" },
      },
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  const notRegistered = { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  const err = (e: unknown) => ({
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  });

  switch (name) {
    case "list_agents": {
      const { scope, fleet_id, device_id, agent_type, capabilities, online_only } = args as any;
      try {
        const agents = await brokerFetch<Agent[]>("/list-peers", {
          scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId,
          fleet_id, device_id, agent_type, capabilities, online_only,
        });
        if (!agents.length) return { content: [{ type: "text" as const, text: `No agents found (scope: ${scope}).` }] };

        const lines = agents.map((a) => {
          const parts = [`ID: ${a.id}`, `Type: ${a.agent_type} — ${a.agent_name}`];
          if (a.fleet_id) parts.push(`Fleet: ${a.fleet_id}`);
          if (a.device_id) parts.push(`Device: ${a.device_id}`);
          if (a.capabilities?.length) parts.push(`Capabilities: ${a.capabilities.join(", ")}`);
          if (a.summary) parts.push(`Summary: ${a.summary}`);
          parts.push(`Online: ${a.online ? "yes (WS)" : "no"} | Host: ${a.hostname} | Seen: ${a.last_seen}`);
          return parts.join("\n  ");
        });
        return { content: [{ type: "text" as const, text: `Found ${agents.length} agent(s) (scope: ${scope}):\n\n${lines.join("\n\n")}` }] };
      } catch (e) { return err(e); }
    }

    case "send_message": {
      if (!myId) return notRegistered;
      const { to_id, message, qos } = args as { to_id: string; message: string; qos?: QoS };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId, to_id, text: message, qos,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Message sent to ${to_id}` }] };
      } catch (e) { return err(e); }
    }

    case "broadcast": {
      if (!myId) return notRegistered;
      const { topic, message, qos, retain } = args as { topic: string; message: string; qos?: QoS; retain?: boolean };
      try {
        const result = await brokerFetch<{ ok: boolean; delivered_to?: string[]; error?: string }>("/broadcast", {
          from_id: myId, topic, text: message, qos, retain,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Broadcast failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Broadcast to "${topic}" — ${result.delivered_to?.length ?? 0} recipient(s)` }] };
      } catch (e) { return err(e); }
    }

    case "subscribe": {
      if (!myId) return notRegistered;
      const { topic } = args as { topic: string };
      try {
        await brokerFetch("/subscribe", { id: myId, topic });
        return { content: [{ type: "text" as const, text: `Subscribed to "${topic}"` }] };
      } catch (e) { return err(e); }
    }

    case "unsubscribe": {
      if (!myId) return notRegistered;
      const { topic } = args as { topic: string };
      try {
        await brokerFetch("/unsubscribe", { id: myId, topic });
        return { content: [{ type: "text" as const, text: `Unsubscribed from "${topic}"` }] };
      } catch (e) { return err(e); }
    }

    case "set_summary": {
      if (!myId) return notRegistered;
      const { summary } = args as { summary: string };
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      } catch (e) { return err(e); }
    }

    case "check_messages": {
      if (!myId) return notRegistered;
      try {
        const result = await brokerFetch<PeekMessagesResponse>("/peek-messages", { id: myId });
        if (!result.messages.length) return { content: [{ type: "text" as const, text: "No pending messages." }] };

        const lines = result.messages.map(
          (m) => `From ${m.from_id}${m.topic ? ` [${m.topic}]` : ""} (QoS ${m.qos}, ${m.sent_at}):\n${m.text}`
        );
        const ids = result.messages.map((m) => m.id);

        // ACK — message delivered to Claude via tool response (guaranteed path)
        await brokerFetch("/ack-messages", { id: myId, message_ids: ids }).catch(() => {});
        for (const id of ids) pushedMessageIds.delete(id);

        return { content: [{ type: "text" as const, text: `${result.messages.length} message(s):\n\n${lines.join("\n\n---\n\n")}` }] };
      } catch (e) { return err(e); }
    }

    case "get_dead_letters": {
      if (!myId) return notRegistered;
      const { limit } = args as { limit?: number };
      try {
        const result = await brokerFetch<{ dead_letters: any[] }>("/dead-letters", { id: myId, limit });
        if (!result.dead_letters.length) return { content: [{ type: "text" as const, text: "No dead letters." }] };
        const lines = result.dead_letters.map(
          (d) => `From ${d.from_id}${d.topic ? ` [${d.topic}]` : ""} (${d.failed_at}) — ${d.reason}:\n${d.text}`
        );
        return { content: [{ type: "text" as const, text: `${result.dead_letters.length} dead letter(s):\n\n${lines.join("\n\n---\n\n")}` }] };
      } catch (e) { return err(e); }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  if (!(await isBrokerAlive())) {
    throw new Error(`Cannot reach agentmesh broker at ${BROKER_URL}. Is it running?`);
  }
  log(`Broker reachable at ${BROKER_URL}`);

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // Register via HTTP
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    hostname: require("os").hostname(),
    summary: "",
    fleet_id: FLEET_ID,
    device_id: DEVICE_ID,
    agent_type: "claude-code",
    agent_name: AGENT_NAME,
    capabilities: CAPABILITIES,
    transport: { type: "websocket" },
    default_qos: 1,
  });
  myId = reg.id;
  myToken = reg.token;
  log(`Registered as ${AGENT_NAME} (${myId})`);

  // Connect MCP stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // Start HTTP polling as immediate fallback
  startPolling();

  // Attempt WebSocket connection (disables polling on success)
  connectWebSocket();

  // Heartbeat — keep agent alive in broker registry
  const heartbeatTimer = setInterval(async () => {
    if (!myId) return;
    try {
      // Heartbeat via WS ping if connected, otherwise HTTP
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "PING" } satisfies WsClientFrame));
      } else {
        await brokerFetch("/heartbeat", { id: myId });
      }
    } catch {}
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on exit
  const cleanup = async () => {
    clearInterval(heartbeatTimer);
    stopPolling();
    if (ws) {
      ws.send(JSON.stringify({ type: "DISCONNECT" } satisfies WsClientFrame));
      ws.close(1000);
    }
    if (myId) {
      try { await brokerFetch("/unregister", { id: myId }); } catch {}
      log("Unregistered");
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
