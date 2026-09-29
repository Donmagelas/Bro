export type InputMode = "queue" | "steer";
export type RunStatus =
  | "idle"
  | "starting"
  | "waiting"
  | "running"
  | "interrupted"
  | "error";
export type InputStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface Connection {
  id: string;
  name: string;
  kind: "api" | "chatgpt";
  provider: string;
  baseUrl?: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  model: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  configured?: boolean;
}
export interface Source {
  kind: "gui" | "feishu" | "peer" | "monitor" | "session";
  connectionId?: string;
  senderId?: string;
  chatId?: string;
  messageId?: string;
  chatType?: "private" | "group";
  sessionId?: string;
  requestId?: string;
  correlationId?: string;
}
export interface Attachment {
  path: string;
  name: string;
  mimeType: string;
}
export interface Annotation {
  messageId: string;
  quote: string;
  comment: string;
}
export interface Session {
  id: string;
  title: string;
  cwd: string;
  projectId: string | null;
  connectionId: string | null;
  thinking: Thinking;
  archived: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  runtimeFile: string | null;
  status: RunStatus;
  error: string | null;
  queued: number;
}
export interface Project {
  id: string;
  name: string;
  path: string;
}
export interface Input {
  id: string;
  sessionId: string;
  text: string;
  source: Source;
  attachments: Attachment[];
  annotations: Annotation[];
  status: InputStatus;
  createdAt: number;
  error?: string;
  parentRequestId?: string;
}
export interface Delegation {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  origin: Source;
  originInputId: string;
  targetInputId: string;
  status: InputStatus;
  result?: string;
  createdAt: number;
}
export type ExperimentMode = "normal" | "shadow" | "experimental";
export interface Settings {
  defaultCwd: string;
  defaultConnectionId: string | null;
  memory: boolean;
  trustedFeishuUsers: string[];
  computer: boolean;
  experiments: {
    skills: ExperimentMode;
    context: ExperimentMode;
    compression: ExperimentMode;
    endpoint: string;
    model: string;
    backend: "typesafe" | "laya";
  };
}
export interface Subscription {
  id: string;
  name: string;
  kind: "sse" | "peer" | "file" | "process";
  enabled: boolean;
  targetSessionId: string;
  url?: string;
  path?: string;
  command?: string[];
  me?: string;
  trustedSenders?: string[];
}
export interface Resource {
  id: string;
  kind: "skill" | "plugin" | "mcp";
  name: string;
  source: string;
  projectId: string | null;
  enabled: boolean;
  path?: string;
  version?: string;
  plugin?: any;
  config?: Record<string, unknown>;
}
export interface HostState {
  version: string;
  sessions: Session[];
  archivedSessions: Session[];
  projects: Project[];
  connections: Connection[];
  settings: Settings;
  delegations: Delegation[];
  subscriptions: Subscription[];
  feishu: {
    configured: boolean;
    connected: boolean;
    appId?: string;
    botId?: string;
    error?: string;
  };
  desktop: {
    paused: boolean;
    owner: string | null;
    reason?: string;
    enabled?: boolean;
    detectorReady?: boolean;
    capabilities?: any;
  };
  resources: Omit<Resource, "config" | "plugin">[];
  pendingRefresh: string[];
  runtimeInfo: Record<
    string,
    {
      at: number;
      tools: string[];
      skills: { name: string; filePath: string }[];
      mcp: string[];
      warnings: string[];
    } | null
  >;
  monitorErrors: Record<string, string>;
  bindings: { key: string; sessionId: string }[];
}
export interface RpcMessage {
  id?: string;
  type: string;
  [key: string]: unknown;
}
export interface RuntimeEvent {
  sessionId: string;
  type: string;
  data?: unknown;
}
export interface ChatMessage {
  id: string;
  role: string;
  content: unknown;
  timestamp?: number;
  toolName?: string;
  bro?: { inputs: Partial<Input>[] };
}
export const VERSION = "0.1.0";
