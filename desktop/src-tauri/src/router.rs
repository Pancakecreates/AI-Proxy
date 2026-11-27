use crate::acp_client::{AcpBackend, AcpEndpointConfig, LogFn, StreamSink};
use crate::codex_client::CodexBackend;
use crate::discovery::{merge_antigravity_accounts, resolve_runtime_executable};
use crate::models::{
    assign_unique_display_names, decode_gateway_model_id, peel_effort_and_speed_suffixes,
};
use crate::types::{
    AppSettings, BackendHealthStatus, BackendKind, BackendModelEntry, SpeedMode, ThoughtLevel,
    TurnResult, UnifiedTurnRequest,
};
use futures::future::join_all;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, RwLock};

#[derive(Clone)]
pub enum BackendInstance {
    Acp(Arc<AcpBackend>),
    Codex(Arc<CodexBackend>),
}

impl BackendInstance {
    pub fn key(&self) -> &str {
        match self {
            Self::Acp(a) => &a.cfg.key,
            Self::Codex(_) => "codex",
        }
    }

    pub fn kind(&self) -> BackendKind {
        match self {
            Self::Acp(a) => a.cfg.kind,
            Self::Codex(_) => BackendKind::Codex,
        }
    }

    #[allow(dead_code)]
    pub fn label(&self) -> &str {
        match self {
            Self::Acp(a) => &a.cfg.label,
            Self::Codex(_) => "Codex",
        }
    }

    pub async fn warm_up(&self, force: bool) -> Result<usize, String> {
        match self {
            Self::Acp(a) => a.warm_up(force).await.map(|v| v.len()),
            Self::Codex(c) => c.warm_up(force).await.map(|v| v.len()),
        }
    }

    pub async fn list_models(&self) -> Vec<BackendModelEntry> {
        match self {
            Self::Acp(a) => a.list_models().await,
            Self::Codex(c) => c.list_models().await,
        }
    }

    pub async fn get_status(&self) -> BackendHealthStatus {
        match self {
            Self::Acp(a) => a.get_status().await,
            Self::Codex(c) => c.get_status().await,
        }
    }

    pub async fn run_turn(
        &self,
        native_model_id: &str,
        req: &UnifiedTurnRequest,
        sink: Option<StreamSink>,
        cancel: Option<Arc<Notify>>,
    ) -> Result<TurnResult, String> {
        match self {
            Self::Acp(a) => a.run_turn(native_model_id, req, sink, cancel).await,
            Self::Codex(c) => c.run_turn(native_model_id, req, sink, cancel).await,
        }
    }

    pub async fn shutdown(&self) {
        match self {
            Self::Acp(a) => a.shutdown().await,
            Self::Codex(c) => c.shutdown().await,
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

        if s.enable_devin {
            if let Some(exe) = resolve_runtime_executable("devin", &["devin"], s.devin_path.as_deref()) {
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "devin".into(),
                        kind: BackendKind::Devin,
                        label: "Devin".into(),
                        executable: exe,
                        args: vec!["acp".into(), "--process-model".into(), s.process_model.as_str().into()],
                        env_overrides: HashMap::new(),
                        auth_method_ids: Vec::new(),
                        supports_close_session: true,
                        close_force_meta: true,
                        qualified_prefix: String::new(),
                        description_prefix: "Devin".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_antigravity {
            if let Some(exe) = resolve_runtime_executable("antigravity", &["antigravity"], s.antigravity_path.as_deref()) {
                let accounts = merge_antigravity_accounts(&s.antigravity_accounts);
                for (i, acc) in accounts.into_iter().filter(|a| a.enabled).enumerate() {
                    let num = i + 1;
                    let label = format!("Antigravity {num} ({})", acc.label);
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
                    next.push(BackendInstance::Acp(AcpBackend::new(
                        AcpEndpointConfig {
                            key: format!("antigravity:{}", acc.id),
                            kind: BackendKind::Antigravity,
                            label,
                            executable: exe.clone(),
                            args: vec![
                                "acp".into(),
                                format!("--gemini-dir={}", acc.gemini_dir),
                                format!("--app-data-dir={}", acc.app_data_dir),
                            ],
                            env_overrides: env,
                            auth_method_ids: Vec::new(),
                            supports_close_session: false,
                            close_force_meta: false,
                            qualified_prefix: format!("agy-{}.", acc.id),
                            description_prefix: format!("Antigravity {num}"),
                            opencode_filter: None,
                            discovery_cwd: None,
                        },
                        self.settings.clone(),
                        self.log.clone(),
                    )));
                }
            }
        }

        if s.enable_opencode {
            if let Some(exe) = resolve_runtime_executable("opencode", &["opencode"], s.opencode_path.as_deref()) {
                let mut env = HashMap::new();
                env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), Some("1".into()));
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "opencode".into(),
                        kind: BackendKind::Opencode,
                        label: "OpenCode".into(),
                        executable: exe,
                        args: vec!["acp".into()],
                        env_overrides: env,
                        auth_method_ids: Vec::new(),
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "oc.".into(),
                        description_prefix: "OpenCode".into(),
                        opencode_filter: Some((s.opencode_filter, s.opencode_providers.clone())),
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_grok {
            if let Some(exe) = resolve_runtime_executable("grok", &["grok"], s.grok_path.as_deref()) {
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
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "grok".into(),
                        kind: BackendKind::Grok,
                        label: "Grok".into(),
                        executable: exe,
                        args: vec![
                            "--no-auto-update".into(),
                            "--permission-mode".into(),
                            perm.into(),
                            "agent".into(),
                            "stdio".into(),
                        ],
                        env_overrides: env,
                        auth_method_ids: auth_methods,
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "grok.".into(),
                        description_prefix: "Grok".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_codex {
            if let Some(exe) = resolve_runtime_executable("codex", &["codex"], s.codex_path.as_deref()) {
                next.push(BackendInstance::Codex(CodexBackend::new(
                    exe,
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_copilot {
            if let Some(exe) = resolve_runtime_executable("copilot", &["copilot"], s.copilot_path.as_deref()) {
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "copilot".into(),
                        kind: BackendKind::Copilot,
                        label: "Copilot".into(),
                        executable: exe,
                        args: vec!["--acp".into(), "--no-auto-update".into()],
                        env_overrides: HashMap::new(),
                        auth_method_ids: Vec::new(),
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "copilot.".into(),
                        description_prefix: "GitHub Copilot".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_cursor {
            if let Some(exe) = resolve_runtime_executable("cursor", &["cursor-agent", "agent"], s.cursor_path.as_deref()) {
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "cursor".into(),
                        kind: BackendKind::Cursor,
                        label: "Cursor".into(),
                        executable: exe,
                        args: vec!["acp".into()],
                        env_overrides: HashMap::new(),
                        auth_method_ids: Vec::new(),
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "cursor.".into(),
                        description_prefix: "Cursor".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_cline {
            if let Some(exe) = resolve_runtime_executable("cline", &["cline"], s.cline_path.as_deref()) {
                let mut env = HashMap::new();
                env.insert("CLINE_SESSION_BACKEND_MODE".into(), Some("local".into()));
                env.insert("CLINE_NO_AUTO_UPDATE".into(), Some("1".into()));
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "cline".into(),
                        kind: BackendKind::Cline,
                        label: "Cline".into(),
                        executable: exe,
                        args: vec!["--acp".into()],
                        env_overrides: env,
                        auth_method_ids: vec!["cline".into()],
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "cline.".into(),
                        description_prefix: "Cline".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_mistral {
            if let Some(exe) = resolve_runtime_executable("mistral", &["vibe-acp", "vibe"], s.mistral_path.as_deref()) {
                let mut env = HashMap::new();
                env.insert("VIBE_ENABLE_TELEMETRY".into(), Some("false".into()));
                env.insert("VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG".into(), Some("true".into()));
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "mistral".into(),
                        kind: BackendKind::Mistral,
                        label: "Mistral Vibe".into(),
                        executable: exe,
                        args: Vec::new(),
                        env_overrides: env,
                        auth_method_ids: vec!["browser-auth".into()],
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "mistral.".into(),
                        description_prefix: "Mistral".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_kimi {
            if let Some(exe) = resolve_runtime_executable("kimi", &["kimi"], s.kimi_path.as_deref()) {
                let mut env = HashMap::new();
                env.insert("KIMI_CLI_NO_AUTO_UPDATE".into(), Some("1".into()));
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "kimi".into(),
                        kind: BackendKind::Kimi,
                        label: "Kimi".into(),
                        executable: exe,
                        args: vec!["acp".into()],
                        env_overrides: env,
                        auth_method_ids: Vec::new(),
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "kimi.".into(),
                        description_prefix: "Kimi".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
        }

        if s.enable_hermes {
            if let Some(exe) = resolve_runtime_executable("hermes", &["hermes"], s.hermes_path.as_deref()) {
                next.push(BackendInstance::Acp(AcpBackend::new(
                    AcpEndpointConfig {
                        key: "hermes".into(),
                        kind: BackendKind::Hermes,
                        label: "Hermes".into(),
                        executable: exe,
                        args: vec!["acp".into()],
                        env_overrides: HashMap::new(),
                        auth_method_ids: Vec::new(),
                        supports_close_session: false,
                        close_force_meta: false,
                        qualified_prefix: "hermes.".into(),
                        description_prefix: "Hermes".into(),
                        opencode_filter: None,
                        discovery_cwd: None,
                    },
                    self.settings.clone(),
                    self.log.clone(),
                )));
            }
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

    pub async fn resolve_target(
        &self,
        requested_model: Option<&str>,
    ) -> Result<(BackendInstance, String, Option<ThoughtLevel>, Option<SpeedMode>, String), String> {
        if self.list_models().await.is_empty() {
            self.warm_up(false).await;
        }
        let all_models = self.list_models().await;
        let backends = self.backends.read().await.clone();
        let s = self.settings.read().await.clone();

        let raw = requested_model.unwrap_or("").trim();
        let stripped_1m = raw.strip_suffix("[1m]").or_else(|| raw.strip_suffix("[1M]")).unwrap_or(raw).trim();
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
        cancel: Option<Arc<Notify>>,
    ) -> Result<(TurnResult, String, BackendKind, String, Option<String>), String> {
        let (backend, native_id, hint_effort, hint_speed, resolved_qid) =
            self.resolve_target(req.model.as_deref()).await?;
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
        let res = backend.run_turn(&native_id, &req, sink, cancel).await?;
        Ok((res, bkey, kind, resolved_qid, effective_effort))
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
}

