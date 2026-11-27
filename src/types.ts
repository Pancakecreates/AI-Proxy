export type DevinMode = "bypass" | "accept-edits" | "smart" | "ask" | "plan";
export type ThoughtLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThoughtConfigId = "thought_level" | "effort" | "reasoning_effort";
export type SpeedMode = "standard" | "fast" | "ultrafast";
export type ShowToolsMode = "thinking" | "text" | "none";
export type ProcessModel = "in-process" | "daemon";
export type BackendKind =
  | "devin"
  | "antigravity"
  | "opencode"
  | "grok"
  | "codex"
  | "copilot"
  | "cursor"
  | "cline"
  | "mistral"
  | "kimi"
  | "hermes"
  | "custom";
export type OpenCodeFilterMode = "go-free" | "all" | "custom";

export interface CustomAcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  authMethodId?: string;
  enabled?: boolean;
}

export interface AntigravityAccountConfig {
  id: string;
  label: string;
  geminiDir: string;
  appDataDir: string;
  email?: string;
}

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
  gatewayAliases: boolean;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  idleSessionTtlMs: number;
  maxSessions: number;
  debug: boolean;
  enableDevin?: boolean;
  enableAntigravity?: boolean;
  antigravityPath?: string;
  antigravityGeminiDir?: string;
  antigravityAppDataDir?: string;
  antigravityAccounts?: AntigravityAccountConfig[];
  enableOpencode?: boolean;
  opencodePath?: string;
  opencodeFilter?: OpenCodeFilterMode;
  opencodeProviders?: string[];
  enableGrok?: boolean;
  grokPath?: string;
  xaiApiKey?: string;
  enableCodex?: boolean;
  codexPath?: string;
  enableAnthropic?: boolean;
  enableOpenai?: boolean;
  openaiPort?: number | null;
  enableCopilot?: boolean;
  copilotPath?: string;
  enableCursor?: boolean;
  cursorPath?: string;
  enableCline?: boolean;
  clinePath?: string;
  enableMistral?: boolean;
  mistralPath?: string;
  enableKimi?: boolean;
  kimiPath?: string;
  enableHermes?: boolean;
  hermesPath?: string;
  customAcpAgents?: CustomAcpAgentConfig[];
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

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: AcpAuthMethod[];
}

export interface AcpAvailableModelFallback {
  modelId: string;
  name?: string;
  description?: string;
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
  models?: {
    currentModelId?: string;
    availableModels?: AcpAvailableModelFallback[];
  };
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
  description?: string;
}

export interface BackendModelEntry extends DevinModelEntry {
  backendKey: string;
  backendKind: BackendKind;
  backendLabel: string;
  nativeId: string;
  qualifiedId: string;
}

export interface ConfigCatalog {
  models: DevinModelEntry[];
  modes: string[];
  thoughtLevels: ThoughtLevel[];
  thoughtConfigId: ThoughtConfigId | null;
  thoughtWireValues: Partial<Record<ThoughtLevel, string>>;
  speeds: SpeedMode[];
  currentModel: string | null;
  currentMode: string | null;
  currentThoughtLevel: ThoughtLevel | null;
  currentSpeed: SpeedMode | null;
}

export type AnthropicModelLine = "opus" | "sonnet" | "haiku" | "fable";

export interface AnthropicModelInfo {
  type: "model";
  id: string;
  display_name: string;
  description?: string;
  max_effort_level?: "low" | "medium" | "high" | "xhigh" | "max";
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

export interface RunTurnCallbacks {
  cwd?: string;
  signal?: AbortSignal;
  onThinking?: (chunk: string) => void;
  onText?: (chunk: string) => void;
  onUsage?: (usage: TurnUsage) => void;
}

export interface BackendHealthStatus {
  key: string;
  kind: BackendKind;
  label: string;
  ready: boolean;
  modelsCount: number;
  activeSessions: number;
  error?: string;
}

export interface ProxyBackend {
  readonly key: string;
  readonly kind: BackendKind;
  readonly label: string;
  readonly isReady: boolean;
  readonly activeSessionCount: number;
  warmUp(force?: boolean): Promise<DevinModelEntry[]>;
  listModels(): BackendModelEntry[];
  runTurn(
    nativeModelId: string,
    request: AnthropicMessagesRequest,
    callbacks: RunTurnCallbacks,
    hints?: { requestedEffort?: ThoughtLevel | null; requestedSpeed?: SpeedMode | null },
  ): Promise<TurnResult>;
  getStatus(): BackendHealthStatus;
  closeAll(): Promise<void>;
  shutdown(): Promise<void>;
}
