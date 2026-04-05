#!/usr/bin/env bun
/**
 * agentmesh OpenClaw gateway v0.3.0
 *
 * Thin HTTP bridge that lets OpenClaw agents join the agentmesh broker
 * without speaking the MCP or WebSocket protocol.
 *
 * Each OpenClaw agent gets its own identity on the mesh via a simple
 * register → send/receive → unregister lifecycle.
 *
 * Incoming messages from the broker are queued in memory and delivered
 * either via webhook (if the agent registered one) or via polling.
 *
 * Config (env):
 *   AGENTMESH_BROKER_URL   — broker HTTP URL (default http://127.0.0.1:7899)
 *   OPENCLAW_GATEWAY_PORT  — port to listen on (default 18789)
 *   AGENTMESH_FLEET_ID     — fleet namespace to register agents under
 *   AGENTMESH_DEVICE_ID    — device identifier
 *
 * HTTP API:
 *   POST /register          — Register an OpenClaw agent, get back { agent_id, token }
 *   POST /unregister        — Unregister an agent
 *   POST /send              — Send a direct message { agent_id, token, to_id, text, qos? }
 *   POST /broadcast         — Publish to a topic { agent_id, token, topic, text, qos?, retain? }
 *   POST /subscribe         — Subscribe to topic { agent_id, token, topic }
 *   POST /unsubscribe       — Unsubscribe from topic { agent_id, token, topic }
 *   GET  /messages/:id      — Poll pending messages (returns and clears queue)
 *   POST /incoming          — Internal: broker delivers messages here (webhook transport)
 *   GET  /health            — Gateway health
 *   GET  /agents            — List all agents on the mesh (proxied from broker)
 */

const BROKER_URL = process.env.AGENTMESH_BROKER_URL ?? "http://127.0.0.1:7899";
const PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
const FLEET_ID = process.env.AGENTMESH_FLEET_ID ?? undefined;
const DEVICE_ID = process.env.AGENTMESH_DEVICE_ID ?? undefined;
const GATEWAY_WEBHOOK_URL = process.env.OPENCLAW_GATEWAY_WEBHOOK_URL ?? `http://127.0.0.1:${PORT}/incoming`;

// In-memory message queue per agent_id for polling
const messageQueues = new Map<string, any[]>();

// Map agent_id → token (for proxying authenticated broker calls)
const agentTokens = new Map<string, string>();

// Map agent_id → webhook_url (optional — agent-specific delivery URL)
const agentWebhooks = new Map<string, string>();

// ---------------------------------------------------------------------------
// Broker proxy
// ---------------------------------------------------------------------------

async function brokerFetch<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Broker ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400): Response {
  return json({ ok: false, error: msg }, status);
}

async function parseBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

function authAgent(body: any): { agent_id: string; token: string } | null {
  const { agent_id, token } = body;
  if (!agent_id || !token) return null;
  const stored = agentTokens.get(agent_id);
  if (stored !== token) return null;
  return { agent_id, token };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // GET /health
    if (method === "GET" && path === "/health") {
      try {
        const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(3000) });
        const broker = await res.json() as any;
        return json({ status: "ok", gateway: "openclaw-gateway/0.3.0", broker });
      } catch {
        return json({ status: "degraded", broker: "unreachable" }, 503);
      }
    }

    // GET /agents
    if (method === "GET" && path === "/agents") {
      try {
        const agents = await brokerFetch<any[]>("/list-peers", {
          scope: "fleet",
          cwd: "/",
          git_root: null,
          fleet_id: FLEET_ID,
        });
        return json({ agents });
      } catch (e) {
        return err(`Broker error: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    // GET /messages/:agent_id
    if (method === "GET" && path.startsWith("/messages/")) {
      const agentId = path.slice("/messages/".length);
      if (!agentId) return err("Missing agent_id in path");
      const queue = messageQueues.get(agentId) ?? [];
      messageQueues.set(agentId, []);
      return json({ messages: queue });
    }

    // POST /incoming — broker delivers messages here via webhook
    if (method === "POST" && path === "/incoming") {
      const body = await parseBody(req);
      const { to_id, from_id, text, topic, qos, sent_at } = body;
      if (!to_id) return err("Missing to_id");

      const msg = { from_id, to_id, text, topic: topic ?? null, qos: qos ?? 0, sent_at: sent_at ?? new Date().toISOString() };

      // Try agent-specific webhook first
      const webhook = agentWebhooks.get(to_id);
      if (webhook) {
        try {
          await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg),
            signal: AbortSignal.timeout(5000),
          });
          return json({ ok: true, delivery: "webhook" });
        } catch {
          // Fall through to queue
        }
      }

      // Queue for polling
      if (!messageQueues.has(to_id)) messageQueues.set(to_id, []);
      messageQueues.get(to_id)!.push(msg);
      return json({ ok: true, delivery: "queued" });
    }

    if (method !== "POST") return err("Not found", 404);

    const body = await parseBody(req);

    // POST /register
    if (path === "/register") {
      const {
        agent_name,
        capabilities,
        summary,
        fleet_id,
        device_id,
        webhook_url,
      } = body;

      if (!agent_name) return err("agent_name required");

      try {
        const reg = await brokerFetch<{ id: string; token: string }>("/register", {
          agent_type: "openclaw",
          agent_name,
          capabilities: capabilities ?? [],
          summary: summary ?? "",
          fleet_id: fleet_id ?? FLEET_ID,
          device_id: device_id ?? DEVICE_ID,
          hostname: (await Bun.hostname?.()) ?? "unknown",
          transport: {
            type: "webhook",
            webhook_url: webhook_url ?? GATEWAY_WEBHOOK_URL,
          },
          default_qos: 1,
        });

        agentTokens.set(reg.id, reg.token);
        messageQueues.set(reg.id, []);
        if (webhook_url) agentWebhooks.set(reg.id, webhook_url);

        console.log(`[gateway] Registered OpenClaw agent: ${agent_name} (${reg.id})`);
        return json({ ok: true, agent_id: reg.id, token: reg.token });
      } catch (e) {
        return err(`Registration failed: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    // All remaining routes require auth
    const auth = authAgent(body);
    if (!auth) return err("Invalid agent_id or token", 401);

    // POST /unregister
    if (path === "/unregister") {
      try {
        await brokerFetch("/unregister", { id: auth.agent_id }, auth.token);
        agentTokens.delete(auth.agent_id);
        messageQueues.delete(auth.agent_id);
        agentWebhooks.delete(auth.agent_id);
        console.log(`[gateway] Unregistered agent ${auth.agent_id}`);
        return json({ ok: true });
      } catch (e) {
        return err(`Unregister failed: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    // POST /send
    if (path === "/send") {
      const { to_id, text, qos } = body;
      if (!to_id || !text) return err("to_id and text required");
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: auth.agent_id,
          to_id,
          text,
          qos: qos ?? 1,
        }, auth.token);
        return json(result);
      } catch (e) {
        return err(`Send failed: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    // POST /broadcast
    if (path === "/broadcast") {
      const { topic, text, qos, retain } = body;
      if (!topic || !text) return err("topic and text required");
      try {
        const result = await brokerFetch<{ ok: boolean; delivered_to?: string[]; error?: string }>("/broadcast", {
          from_id: auth.agent_id,
          topic,
          text,
          qos: qos ?? 1,
          retain: retain ?? false,
        }, auth.token);
        return json(result);
      } catch (e) {
        return err(`Broadcast failed: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    // POST /subscribe
    if (path === "/subscribe") {
      const { topic } = body;
      if (!topic) return err("topic required");
      try {
        await brokerFetch("/subscribe", { id: auth.agent_id, topic }, auth.token);
        return json({ ok: true, topic });
      } catch (e) {
        return err(`Subscribe failed: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    // POST /unsubscribe
    if (path === "/unsubscribe") {
      const { topic } = body;
      if (!topic) return err("topic required");
      try {
        await brokerFetch("/unsubscribe", { id: auth.agent_id, topic }, auth.token);
        return json({ ok: true, topic });
      } catch (e) {
        return err(`Unsubscribe failed: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    return err("Unknown route", 404);
  },
});

console.log(`[gateway] OpenClaw gateway listening on :${PORT}`);
console.log(`[gateway] Broker: ${BROKER_URL}`);
if (FLEET_ID) console.log(`[gateway] Fleet: ${FLEET_ID}`);

// Verify broker reachable on startup
try {
  const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const h = await res.json() as any;
  console.log(`[gateway] Broker healthy: ${h.status}`);
} catch (e) {
  console.warn(`[gateway] WARNING: broker unreachable at ${BROKER_URL} — ${e instanceof Error ? e.message : e}`);
}
