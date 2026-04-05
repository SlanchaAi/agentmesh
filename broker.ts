#!/usr/bin/env bun
/**
 * agentmesh broker v0.2.0
 *
 * Fleet-grade agent messaging broker for private networks.
 * Designed for heterogeneous agents (Claude Code, OpenClaw, Hermes, custom)
 * across fleets of devices.
 *
 * Transport: WebSocket (push) + HTTP REST (poll/webhook fallback)
 * Reliability: QoS 0/1, dead-letter queue, message TTL
 * Routing: direct messages + topic pub/sub with MQTT-style wildcards (+ and #)
 * Fleet: hierarchical addressing (fleet/device/agent), LWT, retained messages
 * Discovery: UDP broadcast announcement on LAN
 *
 * Backwards-compatible with claude-peers clients.
 */

import { Database } from "bun:sqlite";
import dgram from "dgram";
import os from "os";
import type {
  AgentId,
  Agent,
  AgentType,
  QoS,
  LwtConfig,
  Message,
  DeadLetter,
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
  GetDeadLettersRequest,
  GetDeadLettersResponse,
  WsClientFrame,
  WsBrokerFrame,
  AgentCard,
  AgentSkill,
} from "./shared/types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.AGENTMESH_PORT ?? process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DISCOVERY_PORT = PORT + 1; // UDP broadcast port
const DB_PATH = process.env.AGENTMESH_DB ?? process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.agentmesh.db`;
const BIND = process.env.AGENTMESH_BIND ?? process.env.CLAUDE_PEERS_BIND ?? "0.0.0.0";
const FLEET_ID = process.env.AGENTMESH_FLEET_ID ?? null;
const VERSION = "agentmesh/0.4.0";

// QoS 1 retry: wait this long for ACK before retrying
const ACK_DEADLINE_MS = parseInt(process.env.AGENTMESH_ACK_DEADLINE_MS ?? "60000", 10);
const MAX_RETRIES = parseInt(process.env.AGENTMESH_MAX_RETRIES ?? "3", 10);
// How long to keep a remote peer with no heartbeat before expiring
const REMOTE_PEER_TTL_MS = parseInt(process.env.AGENTMESH_PEER_TTL_MS ?? "60000", 10);
// Fleet signing secret — if set, all delivered messages include an HMAC-SHA256 signature
const FLEET_SECRET = process.env.AGENTMESH_FLEET_SECRET ?? null;
// Rate limiting — max messages sent per agent per minute (0 = disabled)
const RATE_LIMIT_RPM = parseInt(process.env.AGENTMESH_RATE_LIMIT_RPM ?? "100", 10);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER,
    cwd TEXT,
    git_root TEXT,
    tty TEXT,
    hostname TEXT NOT NULL DEFAULT 'localhost',
    fleet_id TEXT,
    device_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    agent_type TEXT NOT NULL DEFAULT 'claude-code',
    agent_name TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    transport_type TEXT NOT NULL DEFAULT 'poll',
    transport_webhook_url TEXT,
    transport_poll_interval_ms INTEGER,
    default_qos INTEGER NOT NULL DEFAULT 1,
    default_ttl_ms INTEGER,
    token_hash TEXT,
    lwt_topic TEXT,
    lwt_message TEXT,
    lwt_qos INTEGER NOT NULL DEFAULT 0,
    lwt_retain INTEGER NOT NULL DEFAULT 0,
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
    qos INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL,
    expires_at TEXT,
    ack_deadline TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
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

db.run(`
  CREATE TABLE IF NOT EXISTS retained_messages (
    topic TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    text TEXT NOT NULL,
    qos INTEGER NOT NULL DEFAULT 0,
    retained_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_message_id INTEGER,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    topic TEXT,
    failed_at TEXT NOT NULL,
    reason TEXT NOT NULL
  )
`);

// Incremental migrations for existing databases
const migrations: string[] = [
  "ALTER TABLE peers ADD COLUMN fleet_id TEXT",
  "ALTER TABLE peers ADD COLUMN device_id TEXT",
  "ALTER TABLE peers ADD COLUMN default_qos INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE peers ADD COLUMN default_ttl_ms INTEGER",
  "ALTER TABLE peers ADD COLUMN lwt_topic TEXT",
  "ALTER TABLE peers ADD COLUMN lwt_message TEXT",
  "ALTER TABLE peers ADD COLUMN lwt_qos INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE peers ADD COLUMN lwt_retain INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN qos INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE messages ADD COLUMN expires_at TEXT",
  "ALTER TABLE messages ADD COLUMN ack_deadline TEXT",
  "ALTER TABLE messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3",
];
for (const m of migrations) {
  try { db.run(m); } catch {}
}

// Clean orphaned subscriptions on startup
db.run("DELETE FROM subscriptions WHERE agent_id NOT IN (SELECT id FROM peers)");

// ---------------------------------------------------------------------------
// WebSocket connection registry
// ---------------------------------------------------------------------------

type WsData = {
  agent_id: AgentId | null;
  lwt: LwtConfig | null;
  clean_disconnect: boolean; // set to true when DISCONNECT frame received
};

const wsConnections = new Map<AgentId, ReturnType<typeof Bun.serve>["upgrade"] extends (req: any, opts: any) => boolean ? any : any>();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(token);
  return h.digest("hex");
}

function generateToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function validateToken(token: string | undefined): AgentId | null {
  if (!token) return null;
  const hash = hashToken(token);
  const row = db.query("SELECT id FROM peers WHERE token_hash = ?").get(hash) as { id: string } | null;
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Message signing (HMAC-SHA256)
// ---------------------------------------------------------------------------

function signMessage(msg: Pick<Message, "id" | "from_id" | "to_id" | "text" | "sent_at">): string | null {
  if (!FLEET_SECRET) return null;
  const payload = `${msg.id}:${msg.from_id}:${msg.to_id}:${msg.text}:${msg.sent_at}`;
  const h = new Bun.CryptoHasher("sha256", FLEET_SECRET);
  h.update(payload);
  return h.digest("hex");
}

/** Attach signature to a message row before delivery. Mutates in place. */
function attachSignature<T extends Message>(msg: T): T {
  msg.signature = signMessage(msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory sliding window per agent)
// ---------------------------------------------------------------------------

// Map<agent_id, sorted array of send timestamps (ms)>
const rateLimitWindows = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000; // 1 minute

/** Returns true if the agent is within rate limits, false if throttled. */
function checkRateLimit(agentId: string): boolean {
  if (RATE_LIMIT_RPM <= 0) return true; // disabled
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;

  let timestamps = rateLimitWindows.get(agentId) ?? [];
  // Evict entries outside the window
  timestamps = timestamps.filter((t) => t > cutoff);

  if (timestamps.length >= RATE_LIMIT_RPM) return false;

  timestamps.push(now);
  rateLimitWindows.set(agentId, timestamps);
  return true;
}

// ---------------------------------------------------------------------------
// Topic wildcard matching (MQTT-style)
// + matches exactly one path segment
// # matches zero or more trailing segments (must be last)
// ---------------------------------------------------------------------------

function topicMatches(topic: string, pattern: string): boolean {
  if (pattern === "#") return true;
  if (pattern === topic) return true;

  const tParts = topic.split("/");
  const pParts = pattern.split("/");

  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i] === "#") return true;          // matches rest of topic
    if (i >= tParts.length) return false;         // pattern longer than topic
    if (pParts[i] !== "+" && pParts[i] !== tParts[i]) return false;
  }

  return tParts.length === pParts.length;
}

// ---------------------------------------------------------------------------
// Peer cleanup
// ---------------------------------------------------------------------------

function removePeer(id: AgentId) {
  db.run("DELETE FROM peers WHERE id = ?", [id]);
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
  db.run("DELETE FROM subscriptions WHERE agent_id = ?", [id]);
  wsConnections.delete(id);
}

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, hostname, agent_type, last_seen FROM peers").all() as {
    id: string; pid: number | null; hostname: string; agent_type: string; last_seen: string;
  }[];
  const localHostname = os.hostname();

  for (const p of peers) {
    const isLocal = p.hostname === "localhost" || p.hostname === localHostname;
    const isClaudeCode = p.agent_type === "claude-code";

    if (isLocal && isClaudeCode && p.pid) {
      // Local Claude Code instances: verify PID liveness
      try {
        process.kill(p.pid, 0);
      } catch {
        removePeer(p.id);
      }
    } else {
      // All other agents: expire by heartbeat TTL
      const age = Date.now() - new Date(p.last_seen).getTime();
      if (age > REMOTE_PEER_TTL_MS) {
        // Trigger LWT before removing
        triggerLwt(p.id).catch(() => {});
        removePeer(p.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LWT
// ---------------------------------------------------------------------------

async function triggerLwt(agentId: AgentId) {
  const row = db.query(
    "SELECT lwt_topic, lwt_message, lwt_qos, lwt_retain FROM peers WHERE id = ? AND lwt_topic IS NOT NULL"
  ).get(agentId) as { lwt_topic: string; lwt_message: string; lwt_qos: number; lwt_retain: number } | null;

  if (!row) return;

  log(`LWT triggered for ${agentId} → topic: ${row.lwt_topic}`);
  await handleBroadcast({
    from_id: agentId,
    topic: row.lwt_topic,
    text: row.lwt_message,
    qos: row.lwt_qos as QoS,
    retain: !!row.lwt_retain,
  });
}

// ---------------------------------------------------------------------------
// Message delivery
// ---------------------------------------------------------------------------

async function deliverWebhook(url: string, message: Message): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agentmesh.message", message }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pushWs(agentId: AgentId, frame: WsBrokerFrame): boolean {
  const ws = wsConnections.get(agentId);
  if (!ws) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    wsConnections.delete(agentId);
    return false;
  }
}

type DeliveryResult = "ws" | "webhook" | "queued";

async function deliverToAgent(toId: AgentId, message: Message): Promise<DeliveryResult> {
  const signed = attachSignature({ ...message });

  // 1. WebSocket — instant push (preferred for online agents)
  if (wsConnections.has(toId)) {
    const sent = pushWs(toId, { type: "MESSAGE", message: signed });
    if (sent) {
      if (message.qos === 0) markDelivered.run(message.id); // QoS 0: fire-and-forget
      return "ws";
    }
  }

  // 2. Webhook — for non-interactive agents
  const peer = db.query(
    "SELECT transport_type, transport_webhook_url FROM peers WHERE id = ?"
  ).get(toId) as { transport_type: string; transport_webhook_url: string | null } | null;

  if (peer?.transport_type === "webhook" && peer.transport_webhook_url) {
    const ok = await deliverWebhook(peer.transport_webhook_url, signed);
    if (ok) {
      if (message.qos === 0) markDelivered.run(message.id);
      return "webhook";
    }
  }

  // 3. Queue for polling
  return "queued";
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const insertPeer = db.prepare(`
  INSERT INTO peers (
    id, pid, cwd, git_root, tty, hostname, fleet_id, device_id,
    summary, agent_type, agent_name, capabilities,
    transport_type, transport_webhook_url, transport_poll_interval_ms,
    default_qos, default_ttl_ms, token_hash,
    lwt_topic, lwt_message, lwt_qos, lwt_retain,
    registered_at, last_seen
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare("UPDATE peers SET last_seen = ? WHERE id = ?");
const updateSummary = db.prepare("UPDATE peers SET summary = ? WHERE id = ?");
const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
const selectAllPeers = db.prepare("SELECT * FROM peers");
const selectPeersByCwd = db.prepare("SELECT * FROM peers WHERE cwd = ?");
const selectPeersByGitRoot = db.prepare("SELECT * FROM peers WHERE git_root = ?");
const selectPeersByFleet = db.prepare("SELECT * FROM peers WHERE fleet_id = ?");
const selectPeersByDevice = db.prepare("SELECT * FROM peers WHERE device_id = ?");

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, topic, qos, sent_at, expires_at, ack_deadline, max_retries, delivered)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(
  "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC"
);
const markDelivered = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?");

const insertSubscription = db.prepare(
  "INSERT OR IGNORE INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?, ?, ?)"
);
const deleteSubscription = db.prepare("DELETE FROM subscriptions WHERE agent_id = ? AND topic = ?");
const selectAllSubscriptions = db.prepare("SELECT agent_id, topic FROM subscriptions");

// ---------------------------------------------------------------------------
// QoS 1 retry + TTL expiry loop
// ---------------------------------------------------------------------------

setInterval(async () => {
  const now = new Date().toISOString();

  // Retry overdue QoS≥1 messages
  const overdue = db.query(`
    SELECT * FROM messages
    WHERE delivered = 0
      AND qos >= 1
      AND ack_deadline IS NOT NULL
      AND ack_deadline < ?
      AND retry_count < max_retries
  `).all(now) as Message[];

  for (const msg of overdue) {
    const result = await deliverToAgent(msg.to_id, msg);
    const nextDeadline = new Date(Date.now() + ACK_DEADLINE_MS * Math.pow(2, msg.retry_count)).toISOString();
    db.run(
      "UPDATE messages SET retry_count = retry_count + 1, ack_deadline = ? WHERE id = ?",
      [nextDeadline, msg.id]
    );
    log(`Retry ${msg.retry_count + 1}/${msg.max_retries} for message ${msg.id} → ${msg.to_id} (${result})`);
  }

  // Move exhausted messages to dead letter queue
  const exhausted = db.query(`
    SELECT * FROM messages WHERE delivered = 0 AND retry_count >= max_retries
  `).all() as Message[];

  for (const msg of exhausted) {
    db.run(
      "INSERT INTO dead_letters (original_message_id, from_id, to_id, text, topic, failed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [msg.id, msg.from_id, msg.to_id, msg.text, msg.topic, now, "MAX_RETRIES_EXCEEDED"]
    );
    db.run("DELETE FROM messages WHERE id = ?", [msg.id]);
    log(`Dead letter: message ${msg.id} to ${msg.to_id} after ${msg.retry_count} retries`);
  }

  // Expire messages past their TTL
  const expired = db.query(
    "SELECT * FROM messages WHERE delivered = 0 AND expires_at IS NOT NULL AND expires_at < ?"
  ).all(now) as Message[];

  for (const msg of expired) {
    db.run(
      "INSERT INTO dead_letters (original_message_id, from_id, to_id, text, topic, failed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [msg.id, msg.from_id, msg.to_id, msg.text, msg.topic, now, "TTL_EXPIRED"]
    );
    db.run("DELETE FROM messages WHERE id = ?", [msg.id]);
    log(`TTL expired: message ${msg.id} to ${msg.to_id}`);
  }
}, 30_000);

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.error(`[agentmesh] ${msg}`);
}

function hydrateAgent(row: any): Agent {
  return {
    id: row.id,
    pid: row.pid ?? null,
    cwd: row.cwd ?? null,
    git_root: row.git_root ?? null,
    tty: row.tty ?? null,
    fleet_id: row.fleet_id ?? null,
    device_id: row.device_id ?? null,
    hostname: row.hostname ?? "unknown",
    agent_type: (row.agent_type ?? "custom") as AgentType,
    agent_name: row.agent_name ?? "",
    capabilities: JSON.parse(row.capabilities || "[]"),
    summary: row.summary ?? "",
    transport: {
      type: row.transport_type ?? "poll",
      ...(row.transport_webhook_url ? { webhook_url: row.transport_webhook_url } : {}),
      ...(row.transport_poll_interval_ms ? { poll_interval_ms: row.transport_poll_interval_ms } : {}),
    },
    lwt_topic: row.lwt_topic ?? null,
    online: wsConnections.has(row.id),
    registered_at: row.registered_at,
    last_seen: row.last_seen,
  };
}

function insertMessageAndGetId(
  fromId: AgentId,
  toId: AgentId,
  text: string,
  topic: string | null,
  qos: QoS,
  ttlMs: number | null | undefined,
  maxRetries: number
): { id: number; msg: Message } {
  const now = new Date().toISOString();
  const expiresAt = ttlMs && ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null;
  const ackDeadline = qos >= 1 ? new Date(Date.now() + ACK_DEADLINE_MS).toISOString() : null;

  insertMessage.run(fromId, toId, text, topic, qos, now, expiresAt, ackDeadline, maxRetries);
  const msg = db.query("SELECT * FROM messages WHERE rowid = last_insert_rowid()").get() as Message;
  return { id: msg.id, msg };
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket handlers
// ---------------------------------------------------------------------------

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const token = generateToken();
  const now = new Date().toISOString();
  const hostname = body.hostname ?? os.hostname();

  // Clean up any previous registration for same PID+hostname
  if (body.pid) {
    const existing = db.query("SELECT id FROM peers WHERE pid = ? AND hostname = ?")
      .get(body.pid, hostname) as { id: string } | null;
    if (existing) removePeer(existing.id);
  }

  const lwt = (body as any).lwt as LwtConfig | undefined;

  insertPeer.run(
    id,
    body.pid ?? null,
    body.cwd ?? null,
    body.git_root ?? null,
    body.tty ?? null,
    hostname,
    body.fleet_id ?? FLEET_ID ?? null,
    body.device_id ?? null,
    body.summary ?? "",
    body.agent_type ?? "claude-code",
    body.agent_name ?? "",
    JSON.stringify(body.capabilities ?? []),
    body.transport?.type ?? "poll",
    body.transport?.webhook_url ?? null,
    body.transport?.poll_interval_ms ?? null,
    body.default_qos ?? 1,
    body.default_ttl_ms ?? null,
    hashToken(token),
    lwt?.topic ?? null,
    lwt?.message ?? null,
    lwt?.qos ?? 0,
    lwt?.retain ? 1 : 0,
    now,
    now,
  );

  return { id, token };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Agent[] {
  let rows: any[];
  const localHostname = os.hostname();

  switch (body.scope) {
    case "directory":
      rows = body.cwd ? selectPeersByCwd.all(body.cwd) : selectAllPeers.all();
      break;
    case "repo":
      rows = body.git_root
        ? selectPeersByGitRoot.all(body.git_root)
        : body.cwd ? selectPeersByCwd.all(body.cwd) : selectAllPeers.all();
      break;
    case "fleet":
      rows = body.fleet_id ? selectPeersByFleet.all(body.fleet_id) : selectAllPeers.all();
      break;
    case "device":
      rows = body.device_id ? selectPeersByDevice.all(body.device_id) : selectAllPeers.all();
      break;
    default: // "machine"
      rows = selectAllPeers.all();
  }

  if (body.exclude_id) rows = rows.filter((r: any) => r.id !== body.exclude_id);
  if (body.agent_type) rows = rows.filter((r: any) => r.agent_type === body.agent_type);
  if (body.fleet_id) rows = rows.filter((r: any) => r.fleet_id === body.fleet_id);
  if (body.device_id) rows = rows.filter((r: any) => r.device_id === body.device_id);
  if (body.online_only) rows = rows.filter((r: any) => wsConnections.has(r.id));

  if (body.capabilities?.length) {
    rows = rows.filter((r: any) => {
      const caps: string[] = JSON.parse(r.capabilities || "[]");
      return body.capabilities!.every((c) => caps.includes(c));
    });
  }

  // Verify liveness for local Claude Code peers
  rows = rows.filter((r: any) => {
    const isLocal = r.hostname === "localhost" || r.hostname === localHostname;
    if (!isLocal || r.agent_type !== "claude-code" || !r.pid) return true;
    try {
      process.kill(r.pid, 0);
      return true;
    } catch {
      removePeer(r.id);
      return false;
    }
  });

  return rows.map(hydrateAgent);
}

async function handleSendMessage(
  body: SendMessageRequest
): Promise<{ ok: boolean; error?: string }> {
  if (!checkRateLimit(body.from_id)) {
    return { ok: false, error: `Rate limit exceeded (${RATE_LIMIT_RPM} msg/min)` };
  }

  const target = db.query("SELECT id, default_qos, default_ttl_ms FROM peers WHERE id = ?")
    .get(body.to_id) as { id: string; default_qos: number; default_ttl_ms: number | null } | null;

  if (!target) return { ok: false, error: `Agent ${body.to_id} not found` };

  const qos = (body.qos ?? target.default_qos ?? 1) as QoS;
  const ttlMs = body.ttl_ms ?? target.default_ttl_ms ?? null;
  const { msg } = insertMessageAndGetId(
    body.from_id, body.to_id, body.text, null, qos, ttlMs, MAX_RETRIES
  );

  await deliverToAgent(body.to_id, msg);
  return { ok: true };
}

async function handleBroadcast(
  body: BroadcastRequest & { qos?: QoS }
): Promise<{ ok: boolean; delivered_to: string[]; error?: string }> {
  if (!checkRateLimit(body.from_id)) {
    return { ok: false, delivered_to: [], error: `Rate limit exceeded (${RATE_LIMIT_RPM} msg/min)` };
  }

  const qos = (body.qos ?? 1) as QoS;
  const deliveredTo: string[] = [];

  // Find all subscribers whose pattern matches this topic
  const allSubs = selectAllSubscriptions.all() as { agent_id: string; topic: string }[];
  const matching = allSubs.filter(
    (s) => s.agent_id !== body.from_id && topicMatches(body.topic, s.topic)
  );

  for (const sub of matching) {
    // Verify subscriber still exists
    const peer = db.query("SELECT id FROM peers WHERE id = ?").get(sub.agent_id);
    if (!peer) {
      deleteSubscription.run(sub.agent_id, sub.topic);
      continue;
    }

    const ttlMs = body.ttl_ms ?? null;
    const { msg } = insertMessageAndGetId(
      body.from_id, sub.agent_id, body.text, body.topic, qos, ttlMs, MAX_RETRIES
    );
    await deliverToAgent(sub.agent_id, msg);
    deliveredTo.push(sub.agent_id);
  }

  // Handle retained messages
  if (body.retain) {
    db.run(`
      INSERT INTO retained_messages (topic, from_id, text, qos, retained_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topic) DO UPDATE SET
        from_id = excluded.from_id,
        text = excluded.text,
        qos = excluded.qos,
        retained_at = excluded.retained_at
    `, [body.topic, body.from_id, body.text, qos, new Date().toISOString()]);
  }

  return { ok: true, delivered_to: deliveredTo };
}

function handleSubscribe(body: SubscribeRequest): { ok: boolean } {
  insertSubscription.run(body.id, body.topic, new Date().toISOString());

  // Deliver retained message for this topic (if any) — MQTT retained message behavior
  const retained = db.query(
    "SELECT * FROM retained_messages WHERE topic = ?"
  ).get(body.topic) as { topic: string; from_id: string; text: string; qos: number } | null;

  // Also check wildcard: if subscribing to a pattern, find all retained topics matching it
  if (!retained) {
    const allRetained = db.query("SELECT * FROM retained_messages").all() as any[];
    for (const r of allRetained) {
      if (topicMatches(r.topic, body.topic)) {
        const { msg } = insertMessageAndGetId(
          r.from_id, body.id, r.text, r.topic, r.qos as QoS, null, 0
        );
        deliverToAgent(body.id, msg).catch(() => {});
      }
    }
  } else {
    const { msg } = insertMessageAndGetId(
      retained.from_id, body.id, retained.text, retained.topic, retained.qos as QoS, null, 0
    );
    deliverToAgent(body.id, msg).catch(() => {});
  }

  return { ok: true };
}

function handleUnsubscribe(body: SubscribeRequest): { ok: boolean } {
  deleteSubscription.run(body.id, body.topic);
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = (selectUndelivered.all(body.id) as Message[]).map(attachSignature);
  for (const m of messages) markDelivered.run(m.id);
  return { messages };
}

function handlePeekMessages(body: PeekMessagesRequest): PeekMessagesResponse {
  const messages = (selectUndelivered.all(body.id) as Message[]).map(attachSignature);
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): { ok: boolean; acked: number } {
  let acked = 0;
  for (const id of body.message_ids) {
    const msg = db.query(
      "SELECT to_id FROM messages WHERE id = ? AND delivered = 0"
    ).get(id) as { to_id: string } | null;
    if (msg?.to_id === body.id) {
      markDelivered.run(id);
      acked++;
    }
  }
  return { ok: true, acked };
}

function handleGetDeadLetters(body: GetDeadLettersRequest): GetDeadLettersResponse {
  const limit = body.limit ?? 50;
  const dead_letters = db.query(
    "SELECT * FROM dead_letters WHERE to_id = ? ORDER BY failed_at DESC LIMIT ?"
  ).all(body.id, limit) as DeadLetter[];
  return { dead_letters };
}

function handleUnregister(body: { id: string }): void {
  removePeer(body.id);
}

// ---------------------------------------------------------------------------
// A2A Agent Cards
// ---------------------------------------------------------------------------

const BROKER_SKILLS: AgentSkill[] = [
  {
    id: "send-message",
    name: "Send Message",
    description: "Send a direct message to a registered agent.",
    tags: ["messaging"],
    examples: ["POST /send-message { from_id, to_id, text }"],
  },
  {
    id: "broadcast",
    name: "Broadcast",
    description: "Publish a message to a topic. All subscribers receive it.",
    tags: ["pub-sub", "messaging"],
    examples: ["POST /broadcast { from_id, topic, text }"],
  },
  {
    id: "subscribe",
    name: "Subscribe",
    description: "Subscribe to a topic pattern. Supports MQTT wildcards (+ and #).",
    tags: ["pub-sub"],
  },
  {
    id: "list-agents",
    name: "List Agents",
    description: "Discover agents on the mesh by fleet, device, type, or capability.",
    tags: ["discovery"],
  },
  {
    id: "register",
    name: "Register",
    description: "Register a new agent on the mesh and receive an agent_id and token.",
    tags: ["identity"],
  },
];

function buildBrokerCard(baseUrl: string): AgentCard {
  return {
    name: "agentmesh broker",
    description: "Fleet-grade agent messaging broker for heterogeneous agents (Claude Code, OpenClaw, Hermes, custom) on private networks. Supports direct messages, topic pub/sub with MQTT wildcards, QoS 0/1, dead-letter queue, LWT, and retained messages.",
    url: baseUrl,
    version: VERSION.replace("agentmesh/", ""),
    provider: {
      organization: "Slancha",
      url: "https://github.com/SlanchaAi/agentmesh",
    },
    capabilities: {
      streaming: true,       // WebSocket push
      pushNotifications: true, // webhook delivery for non-WS agents
      stateTransitionHistory: false,
    },
    authentication: {
      schemes: ["Bearer"],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: BROKER_SKILLS,
  };
}

function buildAgentCard(agent: Agent, baseUrl: string): AgentCard {
  const skills: AgentSkill[] = agent.capabilities.map((cap) => ({
    id: cap,
    name: cap
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    tags: [cap],
  }));

  if (!skills.length) {
    skills.push({
      id: "messaging",
      name: "Messaging",
      description: "Receive and send messages via the agentmesh broker.",
      tags: ["messaging"],
    });
  }

  const addrParts = [agent.fleet_id, agent.device_id, agent.agent_name].filter(Boolean);
  const displayName = addrParts.length ? addrParts.join("/") : agent.agent_name || agent.id;

  return {
    name: displayName,
    description: agent.summary || `${agent.agent_type} agent on ${agent.hostname}`,
    url: `${baseUrl}/agent-card/${agent.id}`,
    version: "0.1.0",
    capabilities: {
      streaming: agent.online,          // WS-connected agents can stream
      pushNotifications: agent.transport.type === "webhook",
      stateTransitionHistory: false,
    },
    authentication: {
      schemes: ["Bearer"],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills,
    agentmesh: {
      agent_id: agent.id,
      agent_type: agent.agent_type,
      fleet_id: agent.fleet_id,
      device_id: agent.device_id,
      online: agent.online,
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket message handler
// ---------------------------------------------------------------------------

function handleWsFrame(ws: any, frame: WsClientFrame) {
  if (frame.type === "CONNECT") {
    let agentId: AgentId | null = null;

    if (frame.agent_id && frame.token) {
      // Authenticate existing agent
      const verified = validateToken(frame.token);
      if (verified !== frame.agent_id) {
        ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED", message: "Invalid token" } satisfies WsBrokerFrame));
        ws.close();
        return;
      }
      agentId = verified;
    } else if (frame.registration) {
      // Register new agent inline
      const { id, token } = handleRegister({
        ...frame.registration,
        transport: { type: "websocket" },
        ...(frame.lwt ? { lwt: frame.lwt } : {}),
      });
      agentId = id;
      const reply: WsBrokerFrame = { type: "CONNECTED", agent_id: id, token };
      ws.send(JSON.stringify(reply));
    } else {
      ws.send(JSON.stringify({ type: "ERROR", code: "UNAUTHORIZED", message: "Provide agent_id+token or registration" } satisfies WsBrokerFrame));
      ws.close();
      return;
    }

    ws.data.agent_id = agentId;
    ws.data.clean_disconnect = false;

    // Store LWT if provided
    if (frame.lwt) {
      ws.data.lwt = frame.lwt;
      db.run(
        "UPDATE peers SET lwt_topic=?, lwt_message=?, lwt_qos=?, lwt_retain=? WHERE id=?",
        [frame.lwt.topic, frame.lwt.message, frame.lwt.qos, frame.lwt.retain ? 1 : 0, agentId]
      );
    }

    wsConnections.set(agentId, ws);
    log(`WS connected: ${agentId}`);

    // Send CONNECTED frame (for existing agents — new agents already got it above)
    if (frame.agent_id) {
      const token = (db.query("SELECT token_hash FROM peers WHERE id=?").get(agentId) as any)?.token_hash ?? "";
      ws.send(JSON.stringify({ type: "CONNECTED", agent_id: agentId, token } satisfies WsBrokerFrame));
    }

    // Drain any queued messages
    const queued = selectUndelivered.all(agentId) as Message[];
    for (const msg of queued) {
      const sent = pushWs(agentId, { type: "MESSAGE", message: msg });
      if (sent && msg.qos === 0) markDelivered.run(msg.id);
    }

  } else if (frame.type === "DISCONNECT") {
    ws.data.clean_disconnect = true;
    if (ws.data.agent_id) {
      wsConnections.delete(ws.data.agent_id);
      removePeer(ws.data.agent_id);
    }
    ws.close(1000, "clean disconnect");

  } else if (frame.type === "ACK") {
    if (!ws.data.agent_id) return;
    const msg = db.query(
      "SELECT to_id FROM messages WHERE id = ? AND delivered = 0"
    ).get(frame.message_id) as { to_id: string } | null;
    if (msg?.to_id === ws.data.agent_id) {
      markDelivered.run(frame.message_id);
    }

  } else if (frame.type === "PING") {
    ws.send(JSON.stringify({ type: "PONG" } satisfies WsBrokerFrame));
    if (ws.data.agent_id) updateLastSeen.run(new Date().toISOString(), ws.data.agent_id);
  }
}

// ---------------------------------------------------------------------------
// HTTP request handler (extracted for clarity)
// ---------------------------------------------------------------------------

const PUBLIC_ENDPOINTS = new Set(["/register", "/health", "/.well-known/agent.json", "/agent-card", "/agent-cards"]);

async function handleHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Health check (GET or POST)
  if (path === "/health") {
    const count = (selectAllPeers.all() as any[]).length;
    return Response.json({
      status: "ok",
      version: VERSION,
      agents: count,
      peers: count, // backwards compat
      ws_connections: wsConnections.size,
      fleet_id: FLEET_ID,
      signing: !!FLEET_SECRET,
      rate_limit_rpm: RATE_LIMIT_RPM > 0 ? RATE_LIMIT_RPM : null,
    });
  }

  // A2A Agent Card — broker's own card (standard discovery endpoint)
  if (req.method === "GET" && (path === "/.well-known/agent.json" || path === "/agent-card")) {
    const baseUrl = `${url.protocol}//${url.host}`;
    return Response.json(buildBrokerCard(baseUrl), {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  // A2A Agent Card — individual registered agent
  if (req.method === "GET" && path.startsWith("/agent-card/")) {
    const agentId = path.slice("/agent-card/".length);
    const row = db.query("SELECT * FROM peers WHERE id = ?").get(agentId) as any | null;
    if (!row) return Response.json({ error: "Agent not found" }, { status: 404 });
    const agent = hydrateAgent(row);
    const baseUrl = `${url.protocol}//${url.host}`;
    return Response.json(buildAgentCard(agent, baseUrl), {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  // A2A Agent Cards — list all agents' cards
  if (req.method === "GET" && path === "/agent-cards") {
    const rows = selectAllPeers.all() as any[];
    const baseUrl = `${url.protocol}//${url.host}`;
    const cards = rows.map((r) => buildAgentCard(hydrateAgent(r), baseUrl));
    return Response.json(cards, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  if (req.method !== "POST") {
    return new Response(VERSION, { status: 200 });
  }

  try {
    const body = await req.json();

    // Auth check — permissive for backwards compat (LAN trust model)
    if (!PUBLIC_ENDPOINTS.has(path)) {
      const auth = req.headers.get("Authorization");
      if (auth) {
        if (!validateToken(auth.replace(/^Bearer /, ""))) {
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
        return Response.json(handleUnsubscribe(body as SubscribeRequest));
      case "/poll-messages":
        return Response.json(handlePollMessages(body as PollMessagesRequest));
      case "/peek-messages":
        return Response.json(handlePeekMessages(body as PeekMessagesRequest));
      case "/ack-messages":
        return Response.json(handleAckMessages(body as AckMessagesRequest));
      case "/dead-letters":
        return Response.json(handleGetDeadLetters(body as GetDeadLettersRequest));
      case "/unregister":
        handleUnregister(body as { id: string });
        return Response.json({ ok: true });
      case "/verify-signature": {
        const { message, signature } = body as { message: Message; signature: string };
        if (!FLEET_SECRET) return Response.json({ ok: false, error: "Signing not configured on this broker" });
        const expected = signMessage(message);
        return Response.json({ ok: expected === signature, valid: expected === signature });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Server (HTTP + WebSocket on same port)
// ---------------------------------------------------------------------------

Bun.serve<WsData>({
  port: PORT,
  hostname: BIND,

  fetch(req, server) {
    // WebSocket upgrade
    if (req.headers.get("Upgrade") === "websocket") {
      const ok = server.upgrade(req, { data: { agent_id: null, lwt: null, clean_disconnect: false } });
      if (ok) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return handleHttpRequest(req);
  },

  websocket: {
    open(ws) {
      // Not authenticated yet — wait for CONNECT frame
    },

    message(ws, data) {
      try {
        const frame = JSON.parse(data as string) as WsClientFrame;
        handleWsFrame(ws, frame);
      } catch (e) {
        ws.send(JSON.stringify({
          type: "ERROR",
          code: "PARSE_ERROR",
          message: e instanceof Error ? e.message : String(e),
        } satisfies WsBrokerFrame));
      }
    },

    close(ws, code) {
      const id = ws.data.agent_id;
      if (!id) return;

      wsConnections.delete(id);

      if (!ws.data.clean_disconnect) {
        // Unexpected disconnect — trigger LWT
        triggerLwt(id).catch(() => {});
        log(`WS disconnected (unexpected): ${id} (code: ${code})`);
      } else {
        log(`WS disconnected (clean): ${id}`);
      }
    },

    // Keep-alive ping from Bun's WS layer every 30s
    idleTimeout: 60,
  },
});

// ---------------------------------------------------------------------------
// LAN discovery via UDP broadcast
// ---------------------------------------------------------------------------

function getLocalIPs(): string[] {
  const ips: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

try {
  const discoverySocket = dgram.createSocket("udp4");
  discoverySocket.bind(0, () => {
    try {
      discoverySocket.setBroadcast(true);
    } catch {}

    const announcement = JSON.stringify({
      type: "AGENTMESH_BROKER",
      version: VERSION,
      broker_http: `http://${os.hostname()}:${PORT}`,
      broker_ws: `ws://${os.hostname()}:${PORT}/ws`,
      fleet_id: FLEET_ID,
      ips: getLocalIPs(),
    });
    const buf = Buffer.from(announcement);

    function announce() {
      discoverySocket.send(buf, 0, buf.length, DISCOVERY_PORT, "255.255.255.255", () => {});
    }

    announce();
    setInterval(announce, 30_000);
    log(`Discovery broadcasting on UDP :${DISCOVERY_PORT}`);
  });
} catch (e) {
  log(`Discovery broadcast unavailable: ${e}`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

log(`Listening on ${BIND}:${PORT} (db: ${DB_PATH})`);
log(`WebSocket: ws://${os.hostname()}:${PORT}/ws`);
if (FLEET_ID) log(`Fleet: ${FLEET_ID}`);
