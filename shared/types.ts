/**
 * agentmesh shared types
 *
 * Designed for fleets of heterogeneous agents on private networks.
 * Drawing from MQTT (QoS, LWT, retained), AMQP (dead letters), and
 * NATS (subject hierarchy, wildcards).
 *
 * Backwards-compatible with claude-peers clients.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type AgentId = string;
export type PeerId = AgentId; // backwards-compat alias

export type AgentType = "claude-code" | "openclaw" | "hermes" | "custom";

// Hierarchical address: fleet/device/agent
// Enables wildcard routing: "prod/+/watchdog" or "prod/#"
export interface AgentAddress {
  fleet_id: string | null;   // e.g. "production", "staging"
  device_id: string | null;  // e.g. "edge-node-42", "raspi-001"
  agent_name: string;        // e.g. "sensor", "orchestrator"
}

// ---------------------------------------------------------------------------
// Quality of Service
// ---------------------------------------------------------------------------

/**
 * QoS 0 — fire-and-forget. No ACK, no retry. Lowest overhead.
 * QoS 1 — at-least-once. Broker retries until ACK. May duplicate.
 * QoS 2 — exactly-once. Four-way handshake. Highest overhead.
 */
export type QoS = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// Last Will and Testament (MQTT-inspired)
// ---------------------------------------------------------------------------

/**
 * Registered at connect time. Broker publishes this message if the agent
 * disconnects without sending a clean DISCONNECT frame — e.g. crash, timeout.
 * Critical for fleet health monitoring.
 */
export interface LwtConfig {
  topic: string;   // topic to publish to on unexpected disconnect
  message: string; // message payload
  qos: QoS;
  retain: boolean; // whether to retain the LWT as last known state
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type TransportType = "poll" | "webhook" | "websocket" | "channel";

export interface TransportConfig {
  type: TransportType;
  webhook_url?: string;      // required if type is "webhook"
  poll_interval_ms?: number; // hint for poll-based agents
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface Agent {
  id: AgentId;
  // Claude Code specific (null for non-claude agents)
  pid: number | null;
  cwd: string | null;
  git_root: string | null;
  tty: string | null;
  // Fleet addressing
  fleet_id: string | null;
  device_id: string | null;
  hostname: string;
  agent_type: AgentType;
  agent_name: string;
  capabilities: string[];
  summary: string;
  transport: TransportConfig;
  lwt_topic: string | null;
  online: boolean;           // true if connected via WebSocket right now
  registered_at: string;
  last_seen: string;
}

export type Peer = Agent; // backwards-compat alias

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  id: number;
  from_id: AgentId;
  to_id: AgentId;
  text: string;
  topic: string | null;   // null = direct message, string = topic broadcast
  qos: QoS;
  sent_at: string;
  expires_at: string | null; // null = no expiry
  retry_count: number;
  max_retries: number;
  delivered: boolean;
}

export interface DeadLetter {
  id: number;
  original_message_id: number | null;
  from_id: AgentId;
  to_id: AgentId;
  text: string;
  topic: string | null;
  failed_at: string;
  reason: "MAX_RETRIES_EXCEEDED" | "TTL_EXPIRED" | "AGENT_NOT_FOUND" | "REJECTED";
}

// ---------------------------------------------------------------------------
// WebSocket protocol frames
// ---------------------------------------------------------------------------

// Client → Broker

export type WsClientFrame =
  | {
      type: "CONNECT";
      // Authenticate existing agent
      agent_id?: AgentId;
      token?: string;
      // Or register new agent inline (omit agent_id/token)
      registration?: Omit<RegisterRequest, "transport">;
      // LWT to register for this connection
      lwt?: LwtConfig;
    }
  | { type: "DISCONNECT" }   // clean disconnect — suppresses LWT
  | { type: "ACK"; message_id: number }      // QoS 1 acknowledgement
  | { type: "PUBREC"; message_id: number }   // QoS 2 step 2
  | { type: "PUBCOMP"; message_id: number }  // QoS 2 step 4
  | { type: "PING" };

// Broker → Client

export type WsBrokerFrame =
  | { type: "CONNECTED"; agent_id: AgentId; token: string }
  | { type: "MESSAGE"; message: Message }
  | { type: "PUBREC"; message_id: number }  // QoS 2 step 2 confirm
  | { type: "PUBREL"; message_id: number }  // QoS 2 step 3
  | { type: "PONG" }
  | { type: "ERROR"; code: string; message: string };

// ---------------------------------------------------------------------------
// HTTP API request/response types
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  pid?: number;
  cwd?: string;
  git_root?: string | null;
  tty?: string | null;
  hostname?: string;
  summary?: string;
  // Fleet addressing
  fleet_id?: string;
  device_id?: string;
  // Agent identity
  agent_type?: AgentType;
  agent_name?: string;
  capabilities?: string[];
  transport?: TransportConfig;
  // Delivery defaults
  default_qos?: QoS;
  default_ttl_ms?: number;
}

export interface RegisterResponse {
  id: AgentId;
  token: string;
}

export interface HeartbeatRequest {
  id: AgentId;
}

export interface SetSummaryRequest {
  id: AgentId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo" | "fleet" | "device";
  cwd?: string;
  git_root?: string | null;
  exclude_id?: AgentId;
  // Filters
  agent_type?: AgentType;
  capabilities?: string[];  // must have ALL of these
  fleet_id?: string;
  device_id?: string;
  online_only?: boolean;    // only return WebSocket-connected agents
}

export interface SendMessageRequest {
  from_id: AgentId;
  to_id: AgentId;
  text: string;
  qos?: QoS;       // default: agent's default_qos or 1
  ttl_ms?: number; // 0 = no expiry
}

export interface BroadcastRequest {
  from_id: AgentId;
  topic: string;
  text: string;
  qos?: QoS;
  ttl_ms?: number;
  retain?: boolean; // store as retained message for this topic
}

export interface SubscribeRequest {
  id: AgentId;
  topic: string; // supports MQTT wildcards: + (one level), # (multi-level suffix)
}

export interface UnsubscribeRequest {
  id: AgentId;
  topic: string;
}

export interface PollMessagesRequest {
  id: AgentId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface PeekMessagesRequest {
  id: AgentId;
}

export interface PeekMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  id: AgentId;
  message_ids: number[];
}

export interface GetDeadLettersRequest {
  id: AgentId;
  limit?: number;
}

export interface GetDeadLettersResponse {
  dead_letters: DeadLetter[];
}

// ---------------------------------------------------------------------------
// A2A Agent Cards (Google Agent-to-Agent protocol)
// https://google.github.io/A2A/
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;              // A2A endpoint (or base broker URL for mesh agents)
  version: string;
  provider?: {
    organization: string;
    url?: string;
  };
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  authentication?: {
    schemes: string[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  // agentmesh extensions
  agentmesh?: {
    agent_id: AgentId;
    agent_type: AgentType;
    fleet_id: string | null;
    device_id: string | null;
    online: boolean;
  };
}
