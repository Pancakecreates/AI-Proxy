use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DevinMode {
    Bypass,
    AcceptEdits,
    Smart,
    Ask,
    Plan,
}

impl Default for DevinMode {
    fn default() -> Self {
        Self::Bypass
    }
}

impl DevinMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bypass => "bypass",
            Self::AcceptEdits => "accept-edits",
            Self::Smart => "smart",
            Self::Ask => "ask",
            Self::Plan => "plan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThoughtLevel {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ThoughtLevel {
    pub const SCALE: [ThoughtLevel; 7] = [
        ThoughtLevel::None,
        ThoughtLevel::Minimal,
        ThoughtLevel::Low,
        ThoughtLevel::Medium,
        ThoughtLevel::High,
        ThoughtLevel::Xhigh,
        ThoughtLevel::Max,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThoughtConfigId {
    ThoughtLevel,
    Effort,
    ReasoningEffort,
}

impl ThoughtConfigId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ThoughtLevel => "thought_level",
            Self::Effort => "effort",
            Self::ReasoningEffort => "reasoning_effort",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeedMode {
    Standard,
    Fast,
    Ultrafast,
}

impl SpeedMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Fast => "fast",
            Self::Ultrafast => "ultrafast",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShowToolsMode {
    Thinking,
    Text,
    None,
}

impl Default for ShowToolsMode {
    fn default() -> Self {
        Self::Thinking
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessModel {
    InProcess,
    Daemon,
}

impl Default for ProcessModel {
    fn default() -> Self {
        Self::InProcess
    }
}

impl ProcessModel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InProcess => "in-process",
            Self::Daemon => "daemon",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Devin,
    Antigravity,
    Opencode,
    Grok,
    Codex,
    Copilot,
    Cursor,
    Cline,
    Mistral,
    Kimi,
    Hermes,
    Custom,
}

impl BackendKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Devin => "devin",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
            Self::Grok => "grok",
            Self::Codex => "codex",
            Self::Copilot => "copilot",
            Self::Cursor => "cursor",
            Self::Cline => "cline",
            Self::Mistral => "mistral",
            Self::Kimi => "kimi",
            Self::Hermes => "hermes",
            Self::Custom => "acp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenCodeFilterMode {
    GoFree,
    All,
    Custom,
}

impl Default for OpenCodeFilterMode {
    fn default() -> Self {
        Self::GoFree
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountConfig {
    pub id: String,
    pub label: String,
    pub gemini_dir: String,
    pub app_data_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAcpAgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub auth_method_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub input_per_1m_usd: f64,
    pub output_per_1m_usd: f64,
    #[serde(default)]
    pub billable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub host: String,
    pub anthropic_port: u16,
    pub enable_anthropic: bool,
    pub openai_port: u16,
    pub enable_openai: bool,
    pub api_key: Option<String>,
    pub cwd: String,
    pub mode: DevinMode,
    pub default_model: String,
    pub thought_level: Option<ThoughtLevel>,
    pub speed: Option<SpeedMode>,
    pub show_tools: ShowToolsMode,
    pub process_model: ProcessModel,
    pub gateway_aliases: bool,
    pub request_timeout_ms: u64,
    pub startup_timeout_ms: u64,
    pub idle_session_ttl_ms: u64,
    pub max_sessions: usize,
    pub debug: bool,

    pub enable_devin: bool,
    pub devin_path: Option<String>,
    pub enable_antigravity: bool,
    pub antigravity_path: Option<String>,
    pub antigravity_accounts: Vec<AntigravityAccountConfig>,
    pub enable_opencode: bool,
    pub opencode_path: Option<String>,
    pub opencode_filter: OpenCodeFilterMode,
    pub opencode_providers: Vec<String>,
    pub enable_grok: bool,
    pub grok_path: Option<String>,
    pub xai_api_key: Option<String>,
    pub enable_codex: bool,
    pub codex_path: Option<String>,
    #[serde(default)]
    pub enable_copilot: bool,
    #[serde(default)]
    pub copilot_path: Option<String>,
    #[serde(default)]
    pub enable_cursor: bool,
    #[serde(default)]
    pub cursor_path: Option<String>,
    #[serde(default)]
    pub enable_cline: bool,
    #[serde(default)]
    pub cline_path: Option<String>,
    #[serde(default)]
    pub enable_mistral: bool,
    #[serde(default)]
    pub mistral_path: Option<String>,
    #[serde(default)]
    pub enable_kimi: bool,
    #[serde(default)]
    pub kimi_path: Option<String>,
    #[serde(default)]
    pub enable_hermes: bool,
    #[serde(default)]
    pub hermes_path: Option<String>,
    #[serde(default)]
    pub custom_acp_agents: Vec<CustomAcpAgentConfig>,

    pub model_map: HashMap<String, String>,
    pub custom_pricing: HashMap<String, ModelPricing>,

    pub theme: String,
    pub accent: String,
    pub density: String,
    pub show_thinking_in_chat: bool,
    pub minimize_to_tray: bool,
    pub auto_start_proxy: bool,
    pub autostart_os: bool,
    #[serde(default = "default_true")]
    pub check_updates_on_start: bool,
    pub language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .to_string_lossy()
            .to_string();
        Self {
            host: "127.0.0.1".to_string(),
            anthropic_port: 8787,
            enable_anthropic: true,
            openai_port: 8788,
            enable_openai: true,
            api_key: None,
            cwd: home,
            mode: DevinMode::Bypass,
            default_model: "swe-2-1-medium".to_string(),
            thought_level: None,
            speed: None,
            show_tools: ShowToolsMode::Thinking,
            process_model: ProcessModel::InProcess,
            gateway_aliases: true,
            request_timeout_ms: 900_000,
            startup_timeout_ms: 45_000,
            idle_session_ttl_ms: 1_800_000,
            max_sessions: 12,
            debug: false,

            enable_devin: true,
            devin_path: None,
            enable_antigravity: true,
            antigravity_path: None,
            antigravity_accounts: Vec::new(),
            enable_opencode: true,
            opencode_path: None,
            opencode_filter: OpenCodeFilterMode::GoFree,
            opencode_providers: Vec::new(),
            enable_grok: true,
            grok_path: None,
            xai_api_key: None,
            enable_codex: true,
            codex_path: None,
            enable_copilot: false,
            copilot_path: None,
            enable_cursor: false,
            cursor_path: None,
            enable_cline: false,
            cline_path: None,
            enable_mistral: false,
            mistral_path: None,
            enable_kimi: false,
            kimi_path: None,
            enable_hermes: false,
            hermes_path: None,
            custom_acp_agents: Vec::new(),

            model_map: HashMap::new(),
            custom_pricing: HashMap::new(),

            theme: "auto".to_string(),
            accent: "copper".to_string(),
            density: "comfortable".to_string(),
            show_thinking_in_chat: true,
            minimize_to_tray: true,
            auto_start_proxy: true,
            autostart_os: false,
            check_updates_on_start: true,
            language: "ru".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawModelEntry {
    pub id: String,
    pub name: String,
    pub supports_images: bool,
    pub description: Option<String>,
    pub supported_efforts: Vec<ThoughtLevel>,
    pub effort_wire_values: HashMap<ThoughtLevel, String>,
    pub default_effort: Option<ThoughtLevel>,
    pub supported_speeds: Vec<SpeedMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendModelEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub gateway_id: String,
    pub supports_images: bool,
    pub description: String,
    pub backend_key: String,
    pub backend_kind: BackendKind,
    pub backend_label: String,
    pub native_id: String,
    pub qualified_id: String,
    pub brand: String,
    pub max_input_tokens: u64,
    pub max_tokens: u64,
    pub supported_efforts: Vec<ThoughtLevel>,
    pub supported_speeds: Vec<SpeedMode>,
    pub is_free: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendHealthStatus {
    pub key: String,
    pub kind: BackendKind,
    pub label: String,
    pub ready: bool,
    pub models_count: usize,
    pub active_sessions: usize,
    pub error: Option<String>,
    pub executable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRuntimeStatus {
    pub running: bool,
    pub starting: bool,
    pub anthropic_url: Option<String>,
    pub openai_url: Option<String>,
    pub models_count: usize,
    pub active_sessions: usize,
    pub backends: Vec<BackendHealthStatus>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRuntimes {
    pub devin_path: Option<String>,
    pub antigravity_path: Option<String>,
    pub opencode_path: Option<String>,
    pub grok_path: Option<String>,
    pub codex_path: Option<String>,
    pub copilot_path: Option<String>,
    pub cursor_path: Option<String>,
    pub cline_path: Option<String>,
    pub mistral_path: Option<String>,
    pub kimi_path: Option<String>,
    pub hermes_path: Option<String>,
    pub antigravity_accounts: Vec<AntigravityAccountConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowInfo {
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub resets_at: Option<String>,
    pub window_minutes: Option<u64>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuotaReport {
    pub account_key: String,
    pub provider: String,
    pub label: String,
    pub email: Option<String>,
    pub signed_in: bool,
    pub windows: Vec<QuotaWindowInfo>,
    pub error: Option<String>,
    pub verification_url: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub thinking_tokens: u64,
    pub measured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub model_id: String,
    pub stop_reason: String,
    pub usage: TurnUsage,
    pub assistant_text: String,
    pub thinking_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogEntry {
    pub id: i64,
    pub created_at: String,
    pub request_id: String,
    pub protocol: String,
    pub method: String,
    pub path: String,
    pub model: String,
    pub resolved_model: Option<String>,
    pub effort: Option<String>,
    pub backend_key: Option<String>,
    pub account_label: Option<String>,
    pub status: u16,
    pub latency_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub thinking_tokens: u64,
    pub usage_source: String,
    pub cost_usd: f64,
    pub api_equivalent_usd: f64,
    pub error: Option<String>,
    pub prompt_preview: Option<String>,
    pub response_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLogEntry {
    pub id: i64,
    pub created_at: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub key: String,
    pub label: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub api_equivalent_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: u64,
    pub success_requests: u64,
    pub error_requests: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_thinking_tokens: u64,
    pub total_cost_usd: f64,
    pub total_api_equivalent_usd: f64,
    pub measured_count: u64,
    pub estimated_count: u64,
    pub avg_latency_ms: f64,
    pub by_day: Vec<UsageBucket>,
    pub by_backend: Vec<UsageBucket>,
    pub by_model: Vec<UsageBucket>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub model_id: String,
    pub protocol: String,
    pub effort: String,
    pub system_prompt: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub thinking: String,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub latency_ms: u64,
    pub cost_usd: f64,
    pub usage_source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    pub role: String,
    pub text: String,
    pub images: Vec<ImageAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone)]
pub struct UnifiedTurnRequest {
    pub model: Option<String>,
    pub system: String,
    pub messages: Vec<NormalizedMessage>,
    pub requested_effort: Option<ThoughtLevel>,
    pub thinking_disabled: bool,
    pub thinking_budget: Option<u64>,
    pub requested_speed: Option<SpeedMode>,
    pub cwd: Option<String>,
}
