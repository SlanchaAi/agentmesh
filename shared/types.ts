// Unique ID for each agent instance (generated on registration)
export type AgentId = string;
// Backwards-compatible alias
export type PeerId = AgentId;

export type AgentType = "claude-code" | "openclaw" | "hermes" | "custom";

export type TransportType = "poll" | "webhook" | "channel";

export interface TransportConfig {
  type: TransportType;
  webhook_url?: string; // required if type is "webhook"
  poll_interval_ms?: number; // hint for poll-based agents
}

export interface Peer {
  id: AgentId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  hostname: string;
  summary: string;
  // agentmesh extensions
  agent_type: AgentType;
  agent_name: string;
  capabilities: string[];
  transport: TransportConfig;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: AgentId;
  to_id: AgentId;
  text: string;
  topic: string | null; // null = direct message, string = topic broadcast
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  hostname?: string;
  summary: string;
  // agentmesh extensions (all optional for backwards compat)
  agent_type?: AgentType;
  agent_name?: string;
  capabilities?: string[];
  transport?: TransportConfig;
}

export interface RegisterResponse {
  id: AgentId;
  token: string; // auth token for subsequent requests
}

export interface HeartbeatRequest {
  id: AgentId;
}

export interface SetSummaryRequest {
  id: AgentId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: AgentId;
  // agentmesh filters
  agent_type?: AgentType;
  capabilities?: string[]; // filter to agents with ALL of these capabilities
}

export interface SendMessageRequest {
  from_id: AgentId;
  to_id: AgentId;
  text: string;
}

export interface BroadcastRequest {
  from_id: AgentId;
  topic: string;
  text: string;
}

export interface SubscribeRequest {
  id: AgentId;
  topic: string;
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
