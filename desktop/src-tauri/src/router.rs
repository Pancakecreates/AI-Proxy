use crate::acp_client::{AcpBackend, AcpEndpointConfig, LogFn, StreamSink};
use crate::cancel::CancelToken;
use crate::codex_client::CodexBackend;
use crate::external_client::ExternalBackend;
use crate::discovery::resolve_runtime_executable;
use crate::models::{
    assign_unique_display_names, decode_gateway_model_id, peel_effort_and_speed_suffixes,
};
use crate::pricing::{default_api_pricing, estimate_tokens_from_chars, uses_per_token_billing};
use crate::types::{
    AppSettings, BackendHealthStatus, BackendKind, BackendModelEntry, SpeedMode, ThoughtLevel,
    TurnResult, UnifiedTurnRequest,
};
use futures::future::join_all;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Clone)]
pub enum BackendInstance {
    Acp(Arc<AcpBackend>),
    Codex(Arc<CodexBackend>),
    External(Arc<ExternalBackend>),
}

impl BackendInstance {
    pub fn key(&self) -> &str {
        match self {
            Self::Acp(a) => &a.cfg.key,
            Self::Codex(c) => &c.key,
            Self::External(e) => &e.key,
        }
    }

    pub fn kind(&self) -> BackendKind {
        match self {
            Self::Acp(a) => a.cfg.kind,
            Self::Codex(_) => BackendKind::Codex,
            Self::External(_) => BackendKind::External,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Acp(a) => &a.cfg.label,
            Self::Codex(c) => &c.label,
            Self::External(e) => &e.cfg.display_name,
        }
    }

    pub async fn warm_up(&self, force: bool) -> Result<usize, String> {
        match self {
            Self::Acp(a) => a.warm_up(force).await.map(|v| v.len()),
            Self::Codex(c) => c.warm_up(force).await.map(|v| v.len()),
            Self::External(e) => e.warm_up(force).await.map(|v| v.len()),
        }
    }

    pub async fn list_models(&self) -> Vec<BackendModelEntry> {
        match self {
            Self::Acp(a) => a.list_models().await,
            Self::Codex(c) => c.list_models().await,
            Self::External(e) => e.list_models().await,
        }
    }

    pub async fn get_status(&self) -> BackendHealthStatus {
        match self {
            Self::Acp(a) => a.get_status().await,
            Self::Codex(c) => c.get_status().await,
            Self::External(e) => e.get_status().await,
        }
    }

    pub async fn run_turn(
        &self,
        native_model_id: &str,
        req: &UnifiedTurnRequest,
        sink: Option<StreamSink>,
        cancel: Option<Arc<CancelToken>>,
    ) -> Result<TurnResult, String> {
        match self {
            Self::Acp(a) => a.run_turn(native_model_id, req, sink, cancel).await,
            Self::Codex(c) => c.run_turn(native_model_id, req, sink, cancel).await,
            Self::External(e) => e.run_turn(native_model_id, req, sink, cancel).await,
        }
    }

    pub async fn shutdown(&self) {
        match self {
            Self::Acp(a) => a.shutdown().await,
            Self::Codex(c) => c.shutdown().await,
            Self::External(e) => e.shutdown().await,
        }
    }
}

pub fn is_model_disabled(settings: &AppSettings, m: &BackendModelEntry) -> bool {
    settings.disabled_models.iter().any(|d| {
        d.eq_ignore_ascii_case(&m.qualified_id) || d.eq_ignore_ascii_case(&m.gateway_id)
    })
}

const FLEX_MODEL_ID: &str = "flex";
const FLEX_ALT_MODEL_ID: &str = "ai-proxy-flex";

fn is_flex_model_slug(slug: &str) -> bool {
    slug.eq_ignore_ascii_case(FLEX_MODEL_ID) || slug.eq_ignore_ascii_case(FLEX_ALT_MODEL_ID)
}

fn flex_catalog_entry(max_input_tokens: u64) -> BackendModelEntry {
    BackendModelEntry {
        id: FLEX_MODEL_ID.to_string(),
        name: "AI Proxy Flex".to_string(),
        display_name: "AI Proxy Flex".to_string(),
        gateway_id: FLEX_MODEL_ID.to_string(),
        supports_images: true,
        description: "Cost-aware routing across enabled models".to_string(),
        backend_key: "flex".to_string(),
        backend_kind: BackendKind::Flex,
        backend_label: "AI Proxy".to_string(),
        native_id: FLEX_MODEL_ID.to_string(),
        qualified_id: FLEX_MODEL_ID.to_string(),
        brand: "flex".to_string(),
        max_input_tokens,
        max_tokens: 16_384,
        supported_efforts: ThoughtLevel::SCALE.to_vec(),
        supported_speeds: Vec::new(),
        is_free: true,
    }
}

fn flex_costs(settings: &AppSettings, m: &BackendModelEntry) -> (f64, f64) {
    let pricing = settings
        .custom_pricing
        .get(&m.native_id)
        .or_else(|| settings.custom_pricing.get(&m.qualified_id))
        .or_else(|| settings.custom_pricing.get(&m.gateway_id))
        .cloned()
        .unwrap_or_else(|| default_api_pricing(&m.native_id));
    let api_price = (pricing.input_per_1m_usd + pricing.output_per_1m_usd) / 2.0;
    let effective_cost = if uses_per_token_billing(settings, m.backend_kind, &pricing) {
        api_price
    } else if m.is_free {
        0.0
    } else {
        // Subscription CLI accounts are not free capacity, but they do not bill per token.
        api_price * 0.15
    };
    (api_price, effective_cost)
}

fn flex_tier_rank(level: ThoughtLevel) -> u8 {
    match level {
        ThoughtLevel::None | ThoughtLevel::Minimal | ThoughtLevel::Low => 0,
        ThoughtLevel::Medium => 1,
        ThoughtLevel::High | ThoughtLevel::Xhigh | ThoughtLevel::Max => 2,
    }
}

fn context_bonus(m: &BackendModelEntry) -> f64 {
    (m.max_input_tokens.max(1) as f64).ln() / 20.0
}

fn flex_score(settings: &AppSettings, m: &BackendModelEntry, tier: ThoughtLevel, median_api_price: f64) -> f64 {
    let (api_price, effective_cost) = flex_costs(settings, m);
    let ctx = context_bonus(m);
    match flex_tier_rank(tier) {
        0 => effective_cost * 3.0 + api_price * 0.5 - ctx * 0.2,
        1 => (api_price - median_api_price).abs() + effective_cost * 0.7 - ctx * 0.1,
        _ => -api_price + effective_cost * 1.5 - ctx * 0.2,
    }
}

fn choose_flex_model(
    settings: &AppSettings,
    candidates: &[BackendModelEntry],
    tier: ThoughtLevel,
) -> Option<BackendModelEntry> {
    if candidates.is_empty() {
        return None;
    }
    let mut prices: Vec<f64> = candidates
        .iter()
        .map(|m| flex_costs(settings, m).0)
        .collect();
    prices.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let median = prices.get(prices.len() / 2).copied().unwrap_or(0.0);

    let mut best: Option<(BackendModelEntry, f64)> = None;
    for candidate in candidates {
        let score = flex_score(settings, candidate, tier, median);
        let replace = match &best {
            None => true,
            Some((current, current_score)) => {
                score < *current_score - 0.000_001
                    || ((score - *current_score).abs() <= 0.000_001
                        && (candidate.max_input_tokens > current.max_input_tokens
                            || (candidate.max_input_tokens == current.max_input_tokens
                                && candidate.qualified_id < current.qualified_id)))
            }
        };
        if replace {
            best = Some((candidate.clone(), score));
        }
    }
    best.map(|(m, _)| m)
}

fn flex_candidates(
    all_models: &[BackendModelEntry],
    settings: &AppSettings,
    request: Option<&UnifiedTurnRequest>,
) -> Vec<BackendModelEntry> {
    let has_images = request
        .map(|r| r.messages.iter().any(|m| !m.images.is_empty()))
        .unwrap_or(false);
    let prompt_chars = request
        .map(|r| {
            r.system.len()
                + r.messages
                    .iter()
                    .map(|m| m.text.len())
                    .sum::<usize>()
        })
        .unwrap_or(0);
    let needed_tokens = if prompt_chars > 0 {
        estimate_tokens_from_chars(prompt_chars) + 1_024
    } else {
        0
    };

    let pool: Vec<BackendModelEntry> = all_models
        .iter()
        .filter(|m| {
            m.backend_kind != BackendKind::Flex
                && !is_model_disabled(settings, m)
                && (!has_images || m.supports_images)
        })
        .cloned()
        .collect();
    if needed_tokens == 0 {
        return pool;
    }
    let fitting: Vec<BackendModelEntry> = pool
        .iter()
        .filter(|m| m.max_input_tokens >= needed_tokens)
        .cloned()
        .collect();
    if fitting.is_empty() { pool } else { fitting }
}

pub struct RunTurnOutput {
    pub turn: TurnResult,
    pub backend_key: String,
    pub backend_label: String,
    pub backend_kind: BackendKind,
    pub resolved_qid: String,
    pub effective_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RunTurnError {
    pub message: String,
    pub backend_key: Option<String>,
    pub backend_label: Option<String>,
    pub resolved_model: Option<String>,
    pub effort: Option<String>,
    pub cancelled: bool,
}

impl From<String> for RunTurnError {
    fn from(message: String) -> Self {
        Self {
            message,
            backend_key: None,
            backend_label: None,
            resolved_model: None,
            effort: None,
            cancelled: false,
        }
    }
}

pub struct BackendRouter {
    backends: RwLock<Vec<BackendInstance>>,
    settings: Arc<RwLock<AppSettings>>,
    log: LogFn,
    warmup_lock: Mutex<()>,
}

impl BackendRouter {
    pub fn new(settings: Arc<RwLock<AppSettings>>, log: LogFn) -> Arc<Self> {
        Arc::new(Self {
            backends: RwLock::new(Vec::new()),
            settings,
            log,
            warmup_lock: Mutex::new(()),
        })
    }

    pub async fn rebuild_backends(&self) {
        let old = {
            let mut g = self.backends.write().await;
            std::mem::take(&mut *g)
        };
        for b in old {
            b.shutdown().await;
        }

        let s = self.settings.read().await.clone();
        let mut next: Vec<BackendInstance> = Vec::new();

        struct AcpBase {
            provider: &'static str,
            kind: BackendKind,
            label: &'static str,
            args: Vec<String>,
            env: HashMap<String, Option<String>>,
            auth: Vec<String>,
            close_session: bool,
            close_force: bool,
            prefix: &'static str,
            desc: &'static str,
            opencode_filter: Option<(crate::types::OpenCodeFilterMode, Vec<String>)>,
        }

        fn push_acp(
            next: &mut Vec<BackendInstance>,
            settings_arc: &Arc<RwLock<AppSettings>>,
            log: &LogFn,
            s: &AppSettings,
            exe: Option<String>,
            base: AcpBase,
        ) {
            let Some(exe) = exe else { return };
            let accounts: Vec<crate::types::ProviderAccountConfig> =
                crate::accounts::accounts_for_provider(s, base.provider)
                    .into_iter()
                    .filter(|a| a.enabled)
                    .collect();
            if accounts.is_empty() && base.provider == "antigravity" {
                return;
            }
            let variants: Vec<Option<crate::types::ProviderAccountConfig>> = if accounts.is_empty() {
                vec![None]
            } else {
                accounts.into_iter().map(Some).collect()
            };
            let multi = variants.len() > 1;
            for (i, acc) in variants.into_iter().enumerate() {
                let mut env = base.env.clone();
                let mut args = base.args.clone();
                let mut prefix = base.prefix.to_string();
                if let Some(a) = &acc {
                    if base.provider == "antigravity" {
                        let app_data = a
                            .app_data_dir
                            .clone()
                            .filter(|v| !v.trim().is_empty())
                            .unwrap_or_else(|| "antigravity-acp".into());
                        args = vec![
                            "acp".into(),
                            format!("--gemini-dir={}", a.profile_dir),
                            format!("--app-data-dir={app_data}"),
                        ];
                        prefix = format!("agy-{}.", a.id);
                    } else {
                        env.extend(crate::accounts::profile_env_overrides(base.provider, a));
                        prefix = crate::accounts::account_model_prefix(base.provider, acc.as_ref(), base.prefix);
                    }
                }
                let key = crate::accounts::account_backend_key(base.provider, acc.as_ref());
                let label = if acc.is_some() {
                    crate::accounts::account_backend_label(base.label, i, acc.as_ref())
                } else {
                    base.label.to_string()
                };
                let desc = if multi {
                    format!("{} {}", base.desc, i + 1)
                } else {
                    base.desc.to_string()
                };
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key,
                        kind: base.kind,
                        label,
                        executable: exe.clone(),
                        args,
                        env_overrides: env,
                        auth_method_ids: base.auth.clone(),
                        supports_close_session: base.close_session,
                        close_force_meta: base.close_force,
                        qualified_prefix: prefix,
                        description_prefix: desc,
                        opencode_filter: base.opencode_filter.clone(),
                        discovery_cwd: None,
                    },
                    settings_arc.clone(),
                    log.clone(),
                )));
            }
        }

        if s.enable_devin {
            let exe = resolve_runtime_executable("devin", &["devin"], s.devin_path.as_deref());
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "devin",
                kind: BackendKind::Devin,
                label: "Devin",
                args: vec!["acp".into(), "--process-model".into(), s.process_model.as_str().into()],
                env: HashMap::new(),
                auth: Vec::new(),
                close_session: true,
                close_force: true,
                prefix: "",
                desc: "Devin",
                opencode_filter: None,
            });
        }

        if s.enable_antigravity {
            let exe = resolve_runtime_executable("antigravity", &["antigravity"], s.antigravity_path.as_deref());
            let mut env = HashMap::new();
            env.insert("WSL_DISTRO_NAME".into(), Some("OpenBot".into()));
            env.insert("ANTIGRAVITY_CLI_NO_AUTO_UPDATE".into(), Some("1".into()));
            for k in [
                "ANTIGRAVITY_AGENT",
                "ANTIGRAVITY_AGENTAPI_EXE",
                "ANTIGRAVITY_APP_DATA_DIR",
                "ANTIGRAVITY_CONVERSATION_ID",
                "ANTIGRAVITY_CSRF_TOKEN",
                "ANTIGRAVITY_LS_ADDRESS",
                "ANTIGRAVITY_LS_VERSION",
                "ANTIGRAVITY_SOURCE_METADATA",
                "ANTIGRAVITY_TRAJECTORY_ID",
                "GEMINI_HOME",
            ] {
                env.insert(k.into(), None);
            }
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "antigravity",
                kind: BackendKind::Antigravity,
                label: "Antigravity",
                args: Vec::new(),
                env,
                auth: Vec::new(),
                close_session: false,
                close_force: false,
                prefix: "agy.",
                desc: "Antigravity",
                opencode_filter: None,
            });
        }

        if s.enable_opencode {
            let exe = resolve_runtime_executable("opencode", &["opencode"], s.opencode_path.as_deref());
            let mut env = HashMap::new();
            env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), Some("1".into()));
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "opencode",
                kind: BackendKind::Opencode,
                label: "OpenCode",
                args: vec!["acp".into()],
                env,
                auth: Vec::new(),
                close_session: false,
                close_force: false,
                prefix: "oc.",
                desc: "OpenCode",
                opencode_filter: Some((s.opencode_filter, s.opencode_providers.clone())),
            });
        }

        if s.enable_grok {
            let exe = resolve_runtime_executable("grok", &["grok"], s.grok_path.as_deref());
            let mut env = HashMap::new();
            env.insert("GROK_OAUTH2_REFERRER".into(), Some("openbot".into()));
            let mut auth_methods = Vec::new();
            if let Some(key) = s.xai_api_key.as_deref().map(|k| k.trim()).filter(|k| !k.is_empty()) {
                env.insert("XAI_API_KEY".into(), Some(key.to_string()));
                auth_methods.push("xai.api_key".to_string());
            }
            auth_methods.push("cached_token".to_string());
            let perm = if s.mode == crate::types::DevinMode::Ask {
                "default"
            } else {
                "bypassPermissions"
            };
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "grok",
                kind: BackendKind::Grok,
                label: "Grok",
                args: vec![
                    "--no-auto-update".into(),
                    "--permission-mode".into(),
                    perm.into(),
                    "agent".into(),
                    "stdio".into(),
                ],
                env,
                auth: auth_methods,
                close_session: false,
                close_force: false,
                prefix: "grok.",
                desc: "Grok",
                opencode_filter: None,
            });
        }

        if s.enable_codex {
            if let Some(exe) = resolve_runtime_executable("codex", &["codex"], s.codex_path.as_deref()) {
                let accounts: Vec<crate::types::ProviderAccountConfig> =
                    crate::accounts::accounts_for_provider(&s, "codex")
                        .into_iter()
                        .filter(|a| a.enabled)
                        .collect();
                let variants: Vec<Option<crate::types::ProviderAccountConfig>> = if accounts.is_empty() {
                    vec![None]
                } else {
                    accounts.into_iter().map(Some).collect()
                };
                for (i, acc) in variants.into_iter().enumerate() {
                    let env = acc
                        .as_ref()
                        .map(|a| crate::accounts::profile_env_overrides("codex", a))
                        .unwrap_or_default();
                    next.push(BackendInstance::Codex(CodexBackend::new_with_profile(
                        exe.clone(),
                        crate::accounts::account_backend_key("codex", acc.as_ref()),
                        if acc.is_some() {
                            crate::accounts::account_backend_label("Codex", i, acc.as_ref())
                        } else {
                            "Codex".to_string()
                        },
                        crate::accounts::account_model_prefix("codex", acc.as_ref(), "codex."),
                        env,
                        self.settings.clone(),
                        self.log.clone(),
                    )));
                }
            }
        }

        if s.enable_copilot {
            let exe = resolve_runtime_executable("copilot", &["copilot"], s.copilot_path.as_deref());
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "copilot",
                kind: BackendKind::Copilot,
                label: "Copilot",
                args: vec!["--acp".into(), "--no-auto-update".into()],
                env: HashMap::new(),
                auth: Vec::new(),
                close_session: false,
                close_force: false,
                prefix: "copilot.",
                desc: "GitHub Copilot",
                opencode_filter: None,
            });
        }

        if s.enable_cursor {
            let exe = resolve_runtime_executable("cursor", &["cursor-agent", "agent"], s.cursor_path.as_deref());
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "cursor",
                kind: BackendKind::Cursor,
                label: "Cursor",
                args: vec!["acp".into()],
                env: HashMap::new(),
                auth: Vec::new(),
                close_session: false,
                close_force: false,
                prefix: "cursor.",
                desc: "Cursor",
                opencode_filter: None,
            });
        }

        if s.enable_cline {
            let exe = resolve_runtime_executable("cline", &["cline"], s.cline_path.as_deref());
            let mut env = HashMap::new();
            env.insert("CLINE_SESSION_BACKEND_MODE".into(), Some("local".into()));
            env.insert("CLINE_NO_AUTO_UPDATE".into(), Some("1".into()));
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "cline",
                kind: BackendKind::Cline,
                label: "Cline",
                args: vec!["--acp".into()],
                env,
                auth: vec!["cline".into()],
                close_session: false,
                close_force: false,
                prefix: "cline.",
                desc: "Cline",
                opencode_filter: None,
            });
        }

        if s.enable_mistral {
            let exe = resolve_runtime_executable("mistral", &["vibe-acp", "vibe"], s.mistral_path.as_deref());
            let mut env = HashMap::new();
            env.insert("VIBE_ENABLE_TELEMETRY".into(), Some("false".into()));
            env.insert("VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG".into(), Some("true".into()));
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "mistral",
                kind: BackendKind::Mistral,
                label: "Mistral Vibe",
                args: Vec::new(),
                env,
                auth: vec!["browser-auth".into()],
                close_session: false,
                close_force: false,
                prefix: "mistral.",
                desc: "Mistral",
                opencode_filter: None,
            });
        }

        if s.enable_kimi {
            let exe = resolve_runtime_executable("kimi", &["kimi"], s.kimi_path.as_deref());
            let mut env = HashMap::new();
            env.insert("KIMI_CLI_NO_AUTO_UPDATE".into(), Some("1".into()));
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "kimi",
                kind: BackendKind::Kimi,
                label: "Kimi",
                args: vec!["acp".into()],
                env,
                auth: Vec::new(),
                close_session: false,
                close_force: false,
                prefix: "kimi.",
                desc: "Kimi",
                opencode_filter: None,
            });
        }

        if s.enable_hermes {
            let exe = resolve_runtime_executable("hermes", &["hermes"], s.hermes_path.as_deref());
            push_acp(&mut next, &self.settings, &self.log, &s, exe, AcpBase {
                provider: "hermes",
                kind: BackendKind::Hermes,
                label: "Hermes",
                args: vec!["acp".into()],
                env: HashMap::new(),
                auth: Vec::new(),
                close_session: false,
                close_force: false,
                prefix: "hermes.",
                desc: "Hermes",
                opencode_filter: None,
            });
        }

        for custom in s.custom_acp_agents.into_iter().filter(|c| c.enabled && !c.command.trim().is_empty()) {
            let mut env = HashMap::new();
            for (k, v) in custom.env {
                env.insert(k, Some(v));
            }
            let auth = custom.auth_method_id.filter(|a| !a.trim().is_empty()).into_iter().collect();
            next.push(BackendInstance::Acp(AcpBackend::new(
                AcpEndpointConfig {
                    key: format!("custom:{}", custom.id),
                    kind: BackendKind::Custom,
                    label: custom.name.clone(),
                    executable: custom.command,
                    args: custom.args,
                    env_overrides: env,
                    auth_method_ids: auth,
                    supports_close_session: false,
                    close_force_meta: false,
                    qualified_prefix: format!("acp-{}.", custom.id),
                    description_prefix: custom.name,
                    opencode_filter: None,
                    discovery_cwd: custom.cwd.filter(|c| !c.trim().is_empty()),
                },
                self.settings.clone(),
                self.log.clone(),
            )));
        }

        for ext in s
            .external_providers
            .into_iter()
            .filter(|e| e.enabled && !e.base_url.trim().is_empty())
        {
            next.push(BackendInstance::External(ExternalBackend::new(
                ext,
                self.settings.clone(),
                self.log.clone(),
            )));
        }

        *self.backends.write().await = next;
    }

    pub async fn warm_up(&self, force: bool) -> Vec<BackendModelEntry> {
        if !force {
            let existing = self.list_models().await;
            if !existing.is_empty() {
                return existing;
            }
        }
        let _lock = self.warmup_lock.lock().await;
        let snapshot = self.backends.read().await.clone();
        let tasks = snapshot.iter().map(|b| async move {
            if let Err(e) = b.warm_up(force).await {
                (self.log)("warn", b.key(), &format!("Ошибка прогрева: {e}"));
            }
        });
        join_all(tasks).await;
        self.list_models().await
    }

    pub async fn list_models(&self) -> Vec<BackendModelEntry> {
        let snapshot = self.backends.read().await.clone();
        let mut all = Vec::new();
        for b in snapshot {
            all.extend(b.list_models().await);
        }
        let settings = self.settings.read().await.clone();
        if settings.flex_enabled && !all.is_empty() {
            let max_input = all
                .iter()
                .map(|m| m.max_input_tokens)
                .max()
                .unwrap_or(262_144);
            all.push(flex_catalog_entry(max_input));
        }
        assign_unique_display_names(&mut all);
        all
    }

    pub async fn get_health_statuses(&self) -> Vec<BackendHealthStatus> {
        let snapshot = self.backends.read().await.clone();
        let mut out = Vec::new();
        for b in snapshot {
            out.push(b.get_status().await);
        }
        out
    }

    pub async fn active_session_count(&self) -> usize {
        let mut total = 0;
        for s in self.get_health_statuses().await {
            total += s.active_sessions;
        }
        total
    }

    #[allow(dead_code)]
    pub async fn resolve_target(
        &self,
        requested_model: Option<&str>,
    ) -> Result<(BackendInstance, String, Option<ThoughtLevel>, Option<SpeedMode>, String), String> {
        self.resolve_target_inner(requested_model, None).await
    }

    async fn resolve_target_inner(
        &self,
        requested_model: Option<&str>,
        request: Option<&UnifiedTurnRequest>,
    ) -> Result<(BackendInstance, String, Option<ThoughtLevel>, Option<SpeedMode>, String), String> {
        if self.list_models().await.is_empty() {
            self.warm_up(false).await;
        }
        let all_models_full = self.list_models().await;
        let backends = self.backends.read().await.clone();
        let s = self.settings.read().await.clone();

        let raw = requested_model.unwrap_or("").trim();
        if !raw.is_empty() {
            if let Some(m) = all_models_full.iter().find(|m| {
                (m.qualified_id.eq_ignore_ascii_case(raw) || m.gateway_id.eq_ignore_ascii_case(raw))
                    && is_model_disabled(&s, m)
            }) {
                return Err(format!(
                    "Модель «{}» отключена в настройках прокси. Включите её в каталоге моделей или выберите другую.",
                    m.display_name
                ));
            }
        }
        let stripped_1m = raw.strip_suffix("[1m]").or_else(|| raw.strip_suffix("[1M]")).unwrap_or(raw).trim();
        let all_models: Vec<_> = all_models_full
            .iter()
            .filter(|m| !is_model_disabled(&s, m))
            .cloned()
            .collect();

        let mapped = s
            .model_map
            .get(raw)
            .or_else(|| s.model_map.get(&raw.to_lowercase()))
            .or_else(|| s.model_map.get(stripped_1m))
            .map(|v| v.as_str())
            .unwrap_or(raw);

        if mapped.is_empty() {
            let b = backends
                .iter()
                .find(|b| b.kind() == BackendKind::Devin)
                .or_else(|| backends.first())
                .cloned()
                .ok_or("Нет активных бэкендов")?;
            return Ok((b, s.default_model.clone(), None, None, s.default_model));
        }

        let flex_slug = decode_gateway_model_id(mapped).unwrap_or_else(|| mapped.to_string());
        let flex_slug = flex_slug
            .strip_suffix("[1m]")
            .or_else(|| flex_slug.strip_suffix("[1M]"))
            .unwrap_or(&flex_slug)
            .to_string();
        let (flex_base, flex_effort, flex_speed) = peel_effort_and_speed_suffixes(&flex_slug);
        if is_flex_model_slug(&flex_base) {
            let tier = flex_effort
                .or_else(|| request.and_then(|r| r.requested_effort))
                .or(s.thought_level)
                .unwrap_or(ThoughtLevel::Medium);
            let pool = flex_candidates(&all_models, &s, request);
            let choice = choose_flex_model(&s, &pool, tier).ok_or_else(|| {
                "Flex не нашёл доступных моделей: включите хотя бы одну модель в каталоге.".to_string()
            })?;
            let backend = backends
                .iter()
                .find(|b| b.key() == choice.backend_key)
                .cloned()
                .ok_or_else(|| format!("Flex выбрал «{}», но его бэкенд недоступен", choice.display_name))?;
            return Ok((
                backend,
                choice.native_id.clone(),
                Some(tier),
                flex_speed,
                choice.qualified_id.clone(),
            ));
        }

        let mut candidates = vec![mapped.to_string()];
        if raw.to_lowercase().ends_with("[1m]") {
            candidates.push(format!("{stripped_1m}-1m"));
            candidates.push(stripped_1m.to_string());
        }

        for cand in &candidates {
            let decoded = decode_gateway_model_id(cand);
            let mut probes = vec![cand.as_str()];
            if let Some(ref d) = decoded {
                probes.push(d.as_str());
            }
            for probe in probes {
                if let Some(m) = all_models.iter().find(|m| {
                    m.qualified_id.eq_ignore_ascii_case(probe) || m.gateway_id.eq_ignore_ascii_case(probe)
                }) {
                    if let Some(b) = backends.iter().find(|b| b.key() == m.backend_key) {
                        return Ok((b.clone(), m.native_id.clone(), None, None, m.qualified_id.clone()));
                    }
                }
            }
        }

        let last = candidates.last().map(|s| s.as_str()).unwrap_or(mapped);
        let eff_slug = decode_gateway_model_id(last).unwrap_or_else(|| last.to_string());
        let (base_slug, eff, spd) = peel_effort_and_speed_suffixes(&eff_slug);

        for probe in [&eff_slug, &base_slug] {
            if probe.is_empty() {
                continue;
            }
            if let Some(m) = all_models.iter().find(|m| {
                m.qualified_id.eq_ignore_ascii_case(probe)
                    || m.native_id.eq_ignore_ascii_case(probe)
            }) {
                if let Some(b) = backends.iter().find(|b| b.key() == m.backend_key) {
                    let exact = probe == &eff_slug;
                    return Ok((
                        b.clone(),
                        m.native_id.clone(),
                        if exact { None } else { eff },
                        if exact { None } else { spd },
                        m.qualified_id.clone(),
                    ));
                }
            }
        }

        Err(format!(
            "Модель «{raw}» недоступна: точное совпадение не найдено в каталоге активных бэкендов. Обновите каталог или включите выбранный бэкенд. Запрос не перенаправлен на другую модель."
        ))
    }

    pub async fn run_turn(
        &self,
        mut req: UnifiedTurnRequest,
        sink: Option<StreamSink>,
        cancel: Option<Arc<CancelToken>>,
    ) -> Result<RunTurnOutput, RunTurnError> {
        let (backend, native_id, hint_effort, hint_speed, resolved_qid) =
            self.resolve_target_inner(req.model.as_deref(), Some(&req)).await?;
        if req.requested_effort.is_none() {
            req.requested_effort = hint_effort;
        }
        if req.requested_speed.is_none() {
            req.requested_speed = hint_speed;
        }
        let effective_effort = req
            .requested_effort
            .or(self.settings.read().await.thought_level)
            .map(|e| e.as_str().to_string());
        let kind = backend.kind();
        let bkey = backend.key().to_string();
        let blabel = backend.label().to_string();
        let cancel_state = cancel.clone();
        match backend.run_turn(&native_id, &req, sink, cancel).await {
            Ok(turn) => Ok(RunTurnOutput {
                turn,
                backend_key: bkey,
                backend_label: blabel,
                backend_kind: kind,
                resolved_qid,
                effective_effort,
            }),
            Err(message) => {
                let cancelled = cancel_state
                    .as_ref()
                    .map(|c| c.is_cancelled())
                    .unwrap_or(false);
                Err(RunTurnError {
                    message,
                    backend_key: Some(bkey),
                    backend_label: Some(blabel),
                    resolved_model: Some(native_id),
                    effort: effective_effort,
                    cancelled,
                })
            }
        }
    }

    pub async fn shutdown(&self) {
        let snapshot = self.backends.read().await.clone();
        for b in snapshot {
            b.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn unavailable_router() -> Arc<BackendRouter> {
        let settings = Arc::new(RwLock::new(AppSettings::default()));
        let log: LogFn = Arc::new(|_, _, _| {});
        let router = BackendRouter::new(settings.clone(), log.clone());
        let backend = AcpBackend::new(
            AcpEndpointConfig {
                key: "devin".into(),
                kind: BackendKind::Devin,
                label: "Devin".into(),
                executable: "ai-proxy-nonexistent-test-backend".into(),
                args: vec![],
                env_overrides: HashMap::new(),
                auth_method_ids: vec![],
                supports_close_session: false,
                close_force_meta: false,
                qualified_prefix: String::new(),
                description_prefix: String::new(),
                opencode_filter: None,
                discovery_cwd: None,
            },
            settings,
            log,
        );
        router.backends.write().await.push(BackendInstance::Acp(backend));
        router
    }

    #[tokio::test]
    async fn unavailable_explicit_model_never_uses_another_backend_default() {
        let router = unavailable_router().await;
        for requested in [
            "claude-fable-acp-agy-a3f9ab07.g--emini-4-hydrogen[1m]",
            "missing-model",
            "agy-a3f9ab07.gemini-4-hydrogen-high",
        ] {
            let result = router.resolve_target(Some(requested)).await;
            assert!(result.is_err(), "unavailable model {requested} was silently replaced");
            assert!(result.err().unwrap().contains(requested));
        }
    }


    fn flex_test_model(id: &str, backend: BackendKind, free: bool, context: u64) -> BackendModelEntry {
        BackendModelEntry {
            id: id.into(),
            name: id.into(),
            display_name: id.into(),
            gateway_id: id.into(),
            supports_images: true,
            description: String::new(),
            backend_key: format!("{backend:?}"),
            backend_kind: backend,
            backend_label: format!("{backend:?}"),
            native_id: id.into(),
            qualified_id: id.into(),
            brand: "test".into(),
            max_input_tokens: context,
            max_tokens: 8192,
            supported_efforts: vec![],
            supported_speeds: vec![],
            is_free: free,
        }
    }

    #[test]
    fn flex_low_prefers_free_or_cheap_models() {
        let settings = AppSettings::default();
        let candidates = vec![
            flex_test_model("claude-opus-5", BackendKind::Devin, false, 1_000_000),
            flex_test_model("opencode-go/kimi-k2.5", BackendKind::Opencode, true, 262_144),
            flex_test_model("expensive-api-model", BackendKind::External, false, 128_000),
        ];
        let chosen = choose_flex_model(&settings, &candidates, ThoughtLevel::Low).expect("low choice");
        assert_eq!(chosen.native_id, "opencode-go/kimi-k2.5");
    }

    #[test]
    fn flex_high_prefers_strong_subscription_model_over_paying_twice() {
        let settings = AppSettings::default();
        let candidates = vec![
            flex_test_model("gemini-4-flash", BackendKind::Antigravity, false, 1_000_000),
            flex_test_model("claude-opus-5", BackendKind::Devin, false, 1_000_000),
            flex_test_model("small-paid-api", BackendKind::External, false, 128_000),
        ];
        let chosen = choose_flex_model(&settings, &candidates, ThoughtLevel::High).expect("high choice");
        assert_eq!(chosen.native_id, "claude-opus-5");
    }
}
