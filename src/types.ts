export type DevinMode = "bypass" | "accept-edits" | "smart" | "ask" | "plan";
export type ThoughtLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SpeedMode = "standard" | "fast" | "ultrafast";
export type ShowToolsMode = "thinking" | "text" | "none";
export type ProcessModel = "in-process" | "daemon";

export interface ProxyConfig {
  help: boolean;
  host: string;
  port: number;
  devinPath: string;
  acpArgs?: string[];
  cwd: string;
  mode: DevinMode;
  defaultModel: string;
  thoughtLevel: ThoughtLevel | null;
  speed: SpeedMode | null;
  showTools: ShowToolsMode;
  processModel: ProcessModel;
  apiKey: string | null;
  modelMap: Record<string, string>;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  idleSessionTtlMs: number;
  maxSessions: number;
  debug: boolean;
}

export interface AcpJsonRpcError {
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
}

export interface AcpJsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: AcpJsonRpcError;
}

export interface AcpConfigSelectOption {
  value: string;
  name?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface AcpConfigGroupOption {
  label?: string;
  options: AcpConfigSelectOption[];
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<AcpConfigSelectOption | AcpConfigGroupOption>;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; title?: string; version?: string };
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpSetConfigResult {
  configOptions?: AcpConfigOption[];
}

export interface AcpContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  name?: string;
  status?: string;
  used?: number;
  size?: number;
  configOptions?: AcpConfigOption[];
  _meta?: Record<string, unknown>;
}

export interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
  name?: string;
}

export interface AcpRequestPermissionParams {
  sessionId?: string;
  toolCall?: Record<string, unknown>;
  options?: AcpPermissionOption[];
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface DevinModelEntry {
  id: string;
  name: string;
  supportsImages: boolean;
}

export interface ConfigCatalog {
  models: DevinModelEntry[];
  modes: DevinMode[];
  thoughtLevels: ThoughtLevel[];
  speeds: SpeedMode[];
  currentModel: string | null;
  currentMode: DevinMode | null;
  currentThoughtLevel: ThoughtLevel | null;
  currentSpeed: SpeedMode | null;
}

export type AnthropicModelLine = "opus" | "sonnet" | "haiku" | "fable";

export interface AnthropicModelInfo {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  line?: AnthropicModelLine;
  capabilities: {
    thinking: {
      types: {
        enabled: { supported: boolean };
        adaptive: { supported: boolean };
        disabled: { supported: boolean };
      };
    };
  };
}

export interface AnthropicModelsListResponse {
  data: AnthropicModelInfo[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | {
      type: "image";
      source?: { type?: string; media_type?: string; data?: string };
    }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | {
      type: "tool_result";
      tool_use_id?: string;
      content?: string | AnthropicContentBlock[];
      is_error?: boolean;
    };

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicThinkingConfig {
  type?: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
}

export interface AnthropicOutputConfig {
  effort?: string;
}

export interface AnthropicMessagesRequest {
  model?: string;
  messages: AnthropicMessageParam[];
  system?: string | Array<{ type?: string; text?: string } | string>;
  max_tokens?: number;
  stream?: boolean;
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  tools?: unknown[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  modelId: string;
  stopReason: "end_turn" | "max_tokens" | "refusal";
  usage: TurnUsage;
  assistantText: string;
}
