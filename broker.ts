#!/usr/bin/env bun
/**
 * agentmesh broker daemon
 *
 * A singleton HTTP server on 0.0.0.0:7899 backed by SQLite.
 * Tracks registered agents (Claude Code, OpenClaw, Hermes, custom)
 * and routes messages between them via poll, webhook, or channel push.
 *
 * Backwards-compatible with claude-peers clients.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  BroadcastRequest,
  SubscribeRequest,
  UnsubscribeRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  PeekMessagesRequest,
  PeekMessagesResponse,
  AckMessagesRequest,
  Peer,
  Message,
  AgentType,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    hostname TEXT NOT NULL DEFAULT 'localhost',
    summary TEXT NOT NULL DEFAULT '',
    agent_type TEXT NOT NULL DEFAULT 'claude-code',
    agent_name TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    transport_type TEXT NOT NULL DEFAULT 'poll',
    transport_webhook_url TEXT,
    transport_poll_interval_ms INTEGER,
    token_hash TEXT,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    topic TEXT,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    agent_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    subscribed_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, topic)
  )
`);

// Migrate existing peers table if needed (add new columns)
try { db.run("ALTER TABLE peers ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude-code'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'poll'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN transport_webhook_url TEXT"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN transport_poll_interval_ms INTEGER"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN token_hash TEXT"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN topic TEXT"); } catch {}

// --- Auth ---

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function validateAuth(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const hash = hashToken(token);
  const peer = db.query("SELECT id FROM peers WHERE token_hash = ?").get(hash) as { id: string } | null;
  return peer?.id ?? null;
}

// --- Stale peer cleanup ---

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, hostname, last_seen, agent_type FROM peers").all() as {
    id: string;
    pid: number;
    hostname: string;
    last_seen: string;
    agent_type: string;
  }[];
  const localHostname = require("os").hostname();
  for (const peer of peers) {
    const isLocal = peer.hostname === "localhost" || peer.hostname === localHostname;
    const isClaudeCode = peer.agent_type === "claude-code";

    if (isLocal && isClaudeCode) {
      // Claude Code instances have real PIDs — verify liveness
      try {
        process.kill(peer.pid, 0);
      } catch {
        removePeer(peer.id);
      }
    } else if (!isLocal) {
      // Remote peers — expire by heartbeat timeout
      const lastSeen = new Date(peer.last_seen).getTime();
      if (Date.now() - lastSeen > 60_000) {
        removePeer(peer.id);
      }
    }
    // Non-claude-code local agents (openclaw, hermes, custom) — skip PID check,
    // expire by heartbeat timeout instead
    else {
      const lastSeen = new Date(peer.last_seen).getTime();
      if (Date.now() - lastSeen > 60_000) {
        removePeer(peer.id);
      }
    }
  }
}

function removePeer(id: string) {
  db.run("DELETE FROM peers WHERE id = ?", [id]);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
  db.run("DELETE FROM subscriptions WHERE agent_id = ?", [id]);
}

// Clean up subscriptions for agents that no longer exist (e.g. after broker restart)
db.run("DELETE FROM subscriptions WHERE agent_id NOT IN (SELECT id FROM peers)");

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, hostname, summary,
    agent_type, agent_name, capabilities, transport_type,
    transport_webhook_url, transport_poll_interval_ms, token_hash,
    registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
const selectAllPeers = db.prepare("SELECT * FROM peers");
const selectPeersByDirectory = db.prepare("SELECT * FROM peers WHERE cwd = ?");
const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ?");

const insertMessage = db.prepare(
  "INSERT INTO messages (from_id, to_id, text, topic, sent_at, delivered) VALUES (?, ?, ?, ?, ?, 0)"
);
const selectUndelivered = db.prepare(
  "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC"
);
const markDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");

const insertSubscription = db.prepare(
  "INSERT OR IGNORE INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?, ?, ?)"
);
const deleteSubscription = db.prepare(
  "DELETE FROM subscriptions WHERE agent_id = ? AND topic = ?"
);
const selectSubscribers = db.prepare(
  "SELECT agent_id FROM subscriptions WHERE topic = ?"
);
const selectAgentSubscriptions = db.prepare(
  "SELECT topic FROM subscriptions WHERE agent_id = ?"
);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Webhook delivery ---

async function deliverWebhook(webhookUrl: string, message: Message): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "agentmesh.message",
        message: {
          id: message.id,
          from_id: message.from_id,
          text: message.text,
          topic: message.topic,
          sent_at: message.sent_at,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryWebhookDelivery(toId: string, message: Message): Promise<boolean> {
  const peer = db
    .query("SELECT transport_type, transport_webhook_url FROM peers WHERE id = ?")
    .get(toId) as { transport_type: string; transport_webhook_url: string | null } | null;

  if (peer?.transport_type === "webhook" && peer.transport_webhook_url) {
    const ok = await deliverWebhook(peer.transport_webhook_url, message);
    if (ok) {
      markDelivered.run(message.id);
    }
    return ok;
  }
  return false; // not a webhook agent, leave for polling
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const token = generateToken();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID on same hostname
  const hostname = body.hostname ?? "localhost";
  const existing = db
    .query("SELECT id FROM peers WHERE pid = ? AND hostname = ?")
    .get(body.pid, hostname) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
    db.run("DELETE FROM subscriptions WHERE agent_id = ?", [existing.id]);
  }

  const agentType = body.agent_type ?? "claude-code";
  const agentName = body.agent_name ?? "";
  const capabilities = JSON.stringify(body.capabilities ?? []);
  const transportType = body.transport?.type ?? "poll";
  const webhookUrl = body.transport?.webhook_url ?? null;
  const pollInterval = body.transport?.poll_interval_ms ?? null;

  insertPeer.run(
    id, body.pid, body.cwd, body.git_root, body.tty, hostname, body.summary,
    agentType, agentName, capabilities, transportType,
    webhookUrl, pollInterval, hashToken(token),
    now, now
  );

  return { id, token };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let rows: any[];

  switch (body.scope) {
    case "directory":
      rows = selectPeersByDirectory.all(body.cwd);
      break;
    case "repo":
      rows = body.git_root ? selectPeersByGitRoot.all(body.git_root) : selectPeersByDirectory.all(body.cwd);
      break;
    default:
      rows = selectAllPeers.all();
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    rows = rows.filter((p: any) => p.id !== body.exclude_id);
  }

  // Filter by agent_type
  if (body.agent_type) {
    rows = rows.filter((p: any) => p.agent_type === body.agent_type);
  }

  // Filter by capabilities (must have ALL requested)
  if (body.capabilities?.length) {
    rows = rows.filter((p: any) => {
      const caps: string[] = JSON.parse(p.capabilities || "[]");
      return body.capabilities!.every((c) => caps.includes(c));
    });
  }

  // Verify local claude-code peers are alive (non-claude-code agents skip PID check)
  const localHostname = require("os").hostname();
  rows = rows.filter((p: any) => {
    const ph = p.hostname ?? "localhost";
    const isLocal = ph === "localhost" || ph === localHostname;
    const isClaudeCode = (p.agent_type ?? "claude-code") === "claude-code";
    if (!isLocal) return true; // remote — trust heartbeat
    if (!isClaudeCode) return true; // non-claude-code local — skip PID check
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      removePeer(p.id);
      return false;
    }
  });

  // Hydrate to Peer shape
  return rows.map((p: any) => ({
    id: p.id,
    pid: p.pid,
    cwd: p.cwd,
    git_root: p.git_root,
    tty: p.tty,
    hostname: p.hostname,
    summary: p.summary,
    agent_type: p.agent_type ?? "claude-code",
    agent_name: p.agent_name ?? "",
    capabilities: JSON.parse(p.capabilities || "[]"),
    transport: {
      type: p.transport_type ?? "poll",
      ...(p.transport_webhook_url ? { webhook_url: p.transport_webhook_url } : {}),
      ...(p.transport_poll_interval_ms ? { poll_interval_ms: p.transport_poll_interval_ms } : {}),
    },
    registered_at: p.registered_at,
    last_seen: p.last_seen,
  }));
}

async function handleSendMessage(body: SendMessageRequest): Promise<{ ok: boolean; error?: string }> {
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const now = new Date().toISOString();
  insertMessage.run(body.from_id, body.to_id, body.text, null, now);

  // Get the inserted message for webhook delivery
  const msg = db.query("SELECT * FROM messages WHERE rowid = last_insert_rowid()").get() as Message;
  await tryWebhookDelivery(body.to_id, msg);

  return { ok: true };
}

async function handleBroadcast(body: BroadcastRequest): Promise<{ ok: boolean; delivered_to: string[] }> {
  const subscribers = selectSubscribers.all(body.topic) as { agent_id: string }[];
  const now = new Date().toISOString();
  const deliveredTo: string[] = [];

  for (const sub of subscribers) {
    if (sub.agent_id === body.from_id) continue; // don't echo back to sender
    // Skip stale subscriptions for agents that no longer exist
    const exists = db.query("SELECT id FROM peers WHERE id = ?").get(sub.agent_id);
    if (!exists) {
      deleteSubscription.run(sub.agent_id, body.topic);
      continue;
    }
    insertMessage.run(body.from_id, sub.agent_id, body.text, body.topic, now);
    const msg = db.query("SELECT * FROM messages WHERE rowid = last_insert_rowid()").get() as Message;
    await tryWebhookDelivery(sub.agent_id, msg);
    deliveredTo.push(sub.agent_id);
  }

  return { ok: true, delivered_to: deliveredTo };
}

function handleSubscribe(body: SubscribeRequest): { ok: boolean } {
  insertSubscription.run(body.id, body.topic, new Date().toISOString());
  return { ok: true };
}

function handleUnsubscribe(body: UnsubscribeRequest): { ok: boolean } {
  deleteSubscription.run(body.id, body.topic);
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  return { messages };
}

function handlePeekMessages(body: PeekMessagesRequest): PeekMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Return without marking delivered — caller must explicitly ack
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): { ok: boolean; acked: number } {
  let acked = 0;
  for (const id of body.message_ids) {
    // Only ack messages belonging to this agent
    const msg = db.query("SELECT to_id FROM messages WHERE id = ? AND delivered = 0").get(id) as { to_id: string } | null;
    if (msg && msg.to_id === body.id) {
      markDelivered.run(id);
      acked++;
    }
  }
  return { ok: true, acked };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
  db.run("DELETE FROM subscriptions WHERE agent_id = ?", [body.id]);
}

// --- HTTP Server ---

// Endpoints that don't require auth
const PUBLIC_ENDPOINTS = new Set(["/register", "/health"]);

Bun.serve({
  port: PORT,
  hostname: process.env.CLAUDE_PEERS_BIND ?? "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({
          status: "ok",
          version: "agentmesh/0.1.0",
          peers: (selectAllPeers.all() as any[]).length,
        });
      }
      return new Response("agentmesh broker", { status: 200 });
    }

    try {
      const body = await req.json();

      // Auth check — skip for public endpoints and for requests without tokens
      // (backwards compat: if no token provided, allow through; broker trusts LAN)
      if (!PUBLIC_ENDPOINTS.has(path)) {
        const auth = req.headers.get("Authorization");
        if (auth) {
          const authedId = validateAuth(req);
          if (!authedId) {
            return Response.json({ error: "invalid token" }, { status: 401 });
          }
        }
      }

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(await handleSendMessage(body as SendMessageRequest));
        case "/broadcast":
          return Response.json(await handleBroadcast(body as BroadcastRequest));
        case "/subscribe":
          return Response.json(handleSubscribe(body as SubscribeRequest));
        case "/unsubscribe":
          return Response.json(handleUnsubscribe(body as UnsubscribeRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/peek-messages":
          return Response.json(handlePeekMessages(body as PeekMessagesRequest));
        case "/ack-messages":
          return Response.json(handleAckMessages(body as AckMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

const BIND = process.env.CLAUDE_PEERS_BIND ?? "0.0.0.0";
console.error(`[agentmesh broker] listening on ${BIND}:${PORT} (db: ${DB_PATH})`);
