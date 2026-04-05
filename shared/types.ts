// Unique ID for each registered agent
export type AgentId = string;

export type AgentType = "claude-code" | "openclaw" | "hermes" | "custom";

export interface TransportConfig {
  type: "poll" | "webhook" | "channel";
  webhook_url?: string;
  poll_interval_ms?: number;
}

export interface Agent {
  id: AgentId;
  agent_type: AgentType;
  agent_name: string;
  capabilities: string[];
  summary: string;
  hostname: string;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  pid: number;
  transport: TransportConfig;
  registered_at: string; // ISO timestamp
  last_seen: string;     // ISO timestamp
}

export interface Message {
  id: number;
  from_id: AgentId;
  to_id: AgentId;
  topic: string | null;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  hostname: string;
  summary: string;
  agent_type: AgentType;
  agent_name: string;
  capabilities: string[];
  transport: TransportConfig;
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

export interface ListAgentsRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: AgentId;
  // Optional filters
  agent_type?: AgentType;
  capabilities?: string[];
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
