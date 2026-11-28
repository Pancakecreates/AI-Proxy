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
  | "custom"
  | "external"
  | "flex";

export type ThoughtLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SpeedMode = "standard" | "fast" | "ultrafast";
export type DevinMode = "bypass" | "accept-edits" | "smart" | "ask" | "plan";
export type ShowToolsMode = "thinking" | "text" | "none";
export type ProcessModel = "in-process" | "daemon";
export type OpenCodeFilterMode = "go-free" | "all" | "custom";

export interface AntigravityAccountConfig {
  id: string;
  label: string;
  geminiDir: string;
  appDataDir: string;
  email?: string | null;
  enabled: boolean;
  managed: boolean;
}

export interface ProviderAccountConfig {
  id: string;
  label: string;
  profileDir: string;
  appDataDir?: string | null;
  email?: string | null;
  enabled: boolean;
  managed: boolean;
}

export interface CustomAcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  authMethodId?: string | null;
  enabled: boolean;
}

export interface ModelPricing {
  inputPer1mUsd: number;
  outputPer1mUsd: number;
  billable: boolean;
}

export type ProxyMode = "inherit" | "disabled" | "custom";

export interface ExternalProviderConfig {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | null;
  enabled: boolean;
  proxyMode: ProxyMode;
  proxyUrl: string | null;
  extraHeaders: Record<string, string>;
  maxOutputTokens: number | null;
}

export interface AppSettings {
  host: string;
  anthropicPort: number;
  enableAnthropic: boolean;
  openaiPort: number;
  enableOpenai: boolean;
  apiKey: string | null;
  cwd: string;
  mode: DevinMode;
  defaultModel: string;
  thoughtLevel: ThoughtLevel | null;
  speed: SpeedMode | null;
  showTools: ShowToolsMode;
  processModel: ProcessModel;
  gatewayAliases: boolean;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  idleSessionTtlMs: number;
  maxSessions: number;
  debug: boolean;

  enableDevin: boolean;
  devinPath: string | null;
  enableAntigravity: boolean;
  antigravityPath: string | null;
  antigravityAccounts: AntigravityAccountConfig[];
  providerAccounts: Record<string, ProviderAccountConfig[]>;
  enableOpencode: boolean;
  opencodePath: string | null;
  opencodeFilter: OpenCodeFilterMode;
  opencodeProviders: string[];
  enableGrok: boolean;
  grokPath: string | null;
  xaiApiKey: string | null;
  enableCodex: boolean;
  codexPath: string | null;
  enableCopilot: boolean;
  copilotPath: string | null;
  enableCursor: boolean;
  cursorPath: string | null;
  enableCline: boolean;
  clinePath: string | null;
  enableMistral: boolean;
  mistralPath: string | null;
  enableKimi: boolean;
  kimiPath: string | null;
  enableHermes: boolean;
  hermesPath: string | null;
  customAcpAgents: CustomAcpAgentConfig[];
  externalProviders: ExternalProviderConfig[];
  proxyUrl: string | null;
  providerProxies?: Record<string, { mode: ProxyMode; proxyUrl: string | null }>;
  disabledModels: string[];
  flexEnabled: boolean;

  modelMap: Record<string, string>;
  customPricing: Record<string, ModelPricing>;

  theme: "auto" | "dark" | "light";
  accent: "copper" | "emerald" | "cobalt" | "zinc";
  density: "comfortable" | "compact";
  showThinkingInChat: boolean;
  minimizeToTray: boolean;
  autoStartProxy: boolean;
  autostartOs: boolean;
  checkUpdatesOnStart?: boolean;
  language: string;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes: string;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number | null;
  publishedAt: string | null;
  checkedAt: string;
}

export interface BackendModelEntry {
  id: string;
  name: string;
  displayName: string;
  gatewayId: string;
  supportsImages: boolean;
  description: string;
  backendKey: string;
  backendKind: BackendKind;
  backendLabel: string;
  nativeId: string;
  qualifiedId: string;
  brand: string;
  maxInputTokens: number;
  maxTokens: number;
  supportedEfforts: ThoughtLevel[];
  supportedSpeeds: SpeedMode[];
  isFree: boolean;
}

export interface BackendHealthStatus {
  key: string;
  kind: BackendKind;
  label: string;
  ready: boolean;
  modelsCount: number;
  activeSessions: number;
  error: string | null;
  executable: string | null;
}

export interface ProxyRuntimeStatus {
  running: boolean;
  starting: boolean;
  anthropicUrl: string | null;
  openaiUrl: string | null;
  modelsCount: number;
  activeSessions: number;
  backends: BackendHealthStatus[];
  lastError: string | null;
}

export interface DetectedRuntimes {
  devinPath: string | null;
  antigravityPath: string | null;
  opencodePath: string | null;
  grokPath: string | null;
  codexPath: string | null;
  copilotPath: string | null;
  cursorPath: string | null;
  clinePath: string | null;
  mistralPath: string | null;
  kimiPath: string | null;
  hermesPath: string | null;
  antigravityAccounts: AntigravityAccountConfig[];
}

export interface QuotaWindowInfo {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  models: string[];
}

export interface AccountQuotaReport {
  accountKey: string;
  provider: string;
  label: string;
  email: string | null;
  signedIn: boolean;
  windows: QuotaWindowInfo[];
  error: string | null;
  verificationUrl: string | null;
  checkedAt: string;
}

export interface RuntimeInstallProgress {
  provider: string;
  status: string;
  progressPercent: number;
  message: string;
}

export interface RequestLogEntry {
  id: number;
  createdAt: string;
  requestId: string;
  protocol: string;
  method: string;
  path: string;
  model: string;
  resolvedModel: string | null;
  effort: string | null;
  backendKey: string | null;
  accountLabel: string | null;
  status: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  usageSource: string;
  costUsd: number;
  apiEquivalentUsd: number;
  error: string | null;
  promptPreview: string | null;
  responsePreview: string | null;
}

export interface AppLogEntry {
  id: number;
  createdAt: string;
  level: string;
  source: string;
  message: string;
}

export interface UsageBucket {
  key: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  apiEquivalentUsd: number;
}

export interface UsageSummary {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  cancelledRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalThinkingTokens: number;
  totalCostUsd: number;
  totalApiEquivalentUsd: number;
  measuredCount: number;
  estimatedCount: number;
  avgLatencyMs: number;
  byDay: UsageBucket[];
  byBackend: UsageBucket[];
  byModel: UsageBucket[];
}

export interface ChatSummary {
  id: string;
  title: string;
  modelId: string;
  protocol: string;
  effort: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessageRecord {
  id: string;
  chatId: string;
  role: string;
  content: string;
  thinking: string;
  modelId: string | null;
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  usageSource: string;
  createdAt: string;
}
