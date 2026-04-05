// Unique ID for each registered agent
export type AgentId = string;
export type PeerId = AgentId; // backwards compat alias

export type AgentType = "claude-code" | "openclaw" | "hermes" | "custom";

export interface TransportConfig {
  type: "poll" | "webhook" | "channel";
  webhook_url?: string;
  poll_interval_ms?: number;
}

// Agent extends the original Peer — new fields are optional for backwards compat
export interface Agent {
  id: AgentId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  hostname: string;
  summary: string;
  registered_at: string;
  last_seen: string;
  // agentmesh extensions (optional — not present on old claude-peers registrations)
  agent_type?: AgentType;
  agent_name?: string;
  capabilities?: string[];
  transport?: TransportConfig;
}

export type Peer = Agent; // backwards compat alias

export interface Message {
  id: number;
  from_id: AgentId;
  to_id: AgentId;
  topic?: string | null;
  text: string;
  sent_at: string;
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
  // agentmesh extensions — optional for backwards compat with claude-peers clients
  agent_type?: AgentType;
  agent_name?: string;
  capabilities?: string[];
  transport?: TransportConfig;
}

export interface RegisterResponse {
  id: AgentId;
  token?: string; // present in agentmesh broker, absent in old claude-peers broker
}

export interface HeartbeatRequest {
  id: AgentId;
}

export interface SetSummaryRequest {
  id: AgentId;
  summary: string;
}

// Kept as ListPeersRequest to match the broker endpoint name (/list-peers)
export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: AgentId;
  // agentmesh filter extensions
  agent_type?: AgentType;
  capabilities?: string[];
}

export type ListAgentsRequest = ListPeersRequest; // convenience alias

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
