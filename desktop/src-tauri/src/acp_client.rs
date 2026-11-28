use crate::activity::{PlanActivityTracker, ToolActivityTracker};
use crate::cancel::CancelToken;
use crate::models::{
    filter_opencode_models, infer_max_input_tokens, infer_model_brand, is_free_opencode_model,
    parse_config_catalog, resolve_speed, resolve_thought_level, to_gateway_model_id,
};
use crate::types::{
    AppSettings, BackendHealthStatus, BackendKind, BackendModelEntry, DevinMode, OpenCodeFilterMode,
    RawModelEntry, SpeedMode, ThoughtConfigId, ThoughtLevel, TurnResult, TurnUsage,
    UnifiedTurnRequest,
};
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

#[derive(Clone)]
pub enum StreamEvent {
    Thinking(String),
    Text(String),
    Usage { input_tokens: u64, output_tokens: u64 },
}

pub type StreamSink = mpsc::UnboundedSender<StreamEvent>;
pub type LogFn = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

#[derive(Clone)]
pub struct AcpEndpointConfig {
    pub key: String,
    pub kind: BackendKind,
    pub label: String,
    pub executable: String,
    pub args: Vec<String>,
    pub env_overrides: HashMap<String, Option<String>>,
    pub auth_method_ids: Vec<String>,
    pub supports_close_session: bool,
    pub close_force_meta: bool,
    pub qualified_prefix: String,
    pub description_prefix: String,
    pub opencode_filter: Option<(OpenCodeFilterMode, Vec<String>)>,
    pub discovery_cwd: Option<String>,
}

struct AcpInner {
    child: Option<Child>,
    stdin: Option<Box<dyn AsyncWrite + Unpin + Send>>,
    initialized: bool,
}

#[derive(Clone)]
struct SessionRecord {
    id: String,
    cwd: String,
    system_hash: String,
    fingerprints: Vec<String>,
    model: Option<String>,
    mode: Option<String>,
    thought_level: Option<ThoughtLevel>,
    thought_config_id: Option<ThoughtConfigId>,
    thought_wire_values: HashMap<ThoughtLevel, String>,
    speed: Option<SpeedMode>,
    supported_modes: Vec<String>,
    supported_thought_levels: Vec<ThoughtLevel>,
    supported_speeds: Vec<SpeedMode>,
    busy: bool,
    last_used_ms: u64,
}

pub struct AcpBackend {
    pub cfg: AcpEndpointConfig,
    settings: Arc<RwLock<AppSettings>>,
    log: LogFn,
    proc_state: Arc<Mutex<AcpInner>>,
    ready_lock: Arc<Mutex<()>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    session_sinks: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>>,
    models: Arc<RwLock<Vec<RawModelEntry>>>,
    default_thought_config_id: Arc<RwLock<Option<ThoughtConfigId>>>,
    default_thought_levels: Arc<RwLock<Vec<ThoughtLevel>>>,
    default_thought_wire: Arc<RwLock<HashMap<ThoughtLevel, String>>>,
    default_modes: Arc<RwLock<Vec<String>>>,
    sessions: Arc<Mutex<HashMap<String, SessionRecord>>>,
    warmup_lock: Arc<Mutex<()>>,
    last_error: Arc<RwLock<Option<String>>>,
    stopping: AtomicBool,
    last_msg_ms: Arc<AtomicU64>,
    tools_in_flight: Arc<AtomicUsize>,
    running_tools: Arc<Mutex<HashMap<String, ()>>>,
}

fn now_ms() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

/// Пока агент выполняет инструмент (сборка, тесты, длинная команда), он
/// законно не присылает событий. На это время лимит тишины не ниже получаса.
const TOOL_IDLE_FLOOR_MS: u64 = 30 * 60_000;

pub fn hash_system(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

pub fn message_fingerprint(role: &str, text: &str, img_count: usize) -> String {
    let mut h = Sha256::new();
    h.update(format!("{role}\0{}\0{img_count}", text.trim()).as_bytes());
    format!("{:x}", h.finalize())
}

fn map_mode_for_backend(kind: BackendKind, requested: DevinMode, supported: &[String]) -> Option<String> {
    if supported.is_empty() {
        return None;
    }
    let req = requested.as_str();
    if supported.iter().any(|m| m == req) {
        return Some(req.to_string());
    }
    if kind == BackendKind::Antigravity {
        let mapped = match requested {
            DevinMode::Bypass | DevinMode::Smart => "auto",
            DevinMode::Ask => "default",
            _ => req,
        };
        if supported.iter().any(|m| m == mapped) {
            return Some(mapped.to_string());
        }
    } else if kind == BackendKind::Opencode {
        let mapped = if requested == DevinMode::Plan { "plan" } else { "build" };
        if supported.iter().any(|m| m == mapped) {
            return Some(mapped.to_string());
        }
    }
    None
}

impl AcpBackend {
    pub fn new(cfg: AcpEndpointConfig, settings: Arc<RwLock<AppSettings>>, log: LogFn) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            settings,
            log,
            proc_state: Arc::new(Mutex::new(AcpInner {
                child: None,
                stdin: None,
                initialized: false,
            })),
            ready_lock: Arc::new(Mutex::new(())),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            session_sinks: Arc::new(Mutex::new(HashMap::new())),
            models: Arc::new(RwLock::new(Vec::new())),
            default_thought_config_id: Arc::new(RwLock::new(None)),
            default_thought_levels: Arc::new(RwLock::new(Vec::new())),
            default_thought_wire: Arc::new(RwLock::new(HashMap::new())),
            default_modes: Arc::new(RwLock::new(Vec::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            warmup_lock: Arc::new(Mutex::new(())),
            last_error: Arc::new(RwLock::new(None)),
            stopping: AtomicBool::new(false),
            last_msg_ms: Arc::new(AtomicU64::new(0)),
            tools_in_flight: Arc::new(AtomicUsize::new(0)),
            running_tools: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn is_ready(&self) -> bool {
        let guard = self.proc_state.lock().await;
        guard.initialized && guard.stdin.is_some()
    }

    pub async fn active_session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    async fn ensure_ready(self: &Arc<Self>) -> Result<(), String> {
        if self.is_ready().await {
            return Ok(());
        }
        let _guard = self.ready_lock.lock().await;
        if self.is_ready().await {
            return Ok(());
        }
        self.start_and_initialize().await
    }

    async fn start_and_initialize(self: &Arc<Self>) -> Result<(), String> {
        self.stopping.store(false, Ordering::SeqCst);
        let startup_ms = self.settings.read().await.startup_timeout_ms;

        (self.log)(
            "info",
            &format!("acp:{}", self.cfg.key),
            &format!("Запуск {} {}", self.cfg.executable, self.cfg.args.join(" ")),
        );

        let mut cmd = Command::new(&self.cfg.executable);
        cmd.args(&self.cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v_opt) in &self.cfg.env_overrides {
            match v_opt {
                Some(v) => {
                    cmd.env(k, v);
                }
                None => {
                    cmd.env_remove(k);
                }
            }
        }
        {
            let proxy = {
                let s = self.settings.read().await;
                crate::net::resolve_provider_proxy(&self.cfg.key, &s.provider_proxies, s.proxy_url.as_deref())
                    .map(str::to_string)
            };
            crate::net::apply_proxy_env(&mut cmd, proxy.as_deref(), &self.cfg.env_overrides);
        }
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Не удалось запустить {}: {e}", self.cfg.label))?;
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take();

        {
            let mut st = self.proc_state.lock().await;
            st.child = Some(child);
            st.stdin = Some(Box::new(stdin));
            st.initialized = false;
        }

        if let Some(err_stream) = stderr {
            let log = self.log.clone();
            let src = format!("acp:{}", self.cfg.key);
            let settings = self.settings.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err_stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if settings.read().await.debug || trimmed.to_lowercase().contains("error") {
                        log("debug", &src, trimmed);
                    }
                }
            });
        }

        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                this.last_msg_ms.store(now_ms(), Ordering::SeqCst);
                this.handle_incoming(msg).await;
            }
            this.handle_process_exit("ACP stdout closed").await;
        });

        let init_res = self
            .rpc_request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": { "name": "ai-proxy-desktop", "title": "AI Proxy", "version": "0.1.0" }
                }),
                startup_ms,
            )
            .await?;

        if !self.cfg.auth_method_ids.is_empty() {
            let advertised: HashSet<String> = init_res
                .get("authMethods")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(method) = self.cfg.auth_method_ids.iter().find(|id| advertised.contains(*id)) {
                self.rpc_request("authenticate", json!({ "methodId": method }), startup_ms)
                    .await?;
            }
        }

        {
            let mut st = self.proc_state.lock().await;
            st.initialized = true;
        }
        Ok(())
    }

    async fn handle_incoming(self: &Arc<Self>, msg: Value) {
        let id = msg.get("id").and_then(|v| v.as_u64());
        let method = msg.get("method").and_then(|v| v.as_str());

        if let (Some(req_id), None) = (id, method) {
            if let Some(tx) = self.pending.lock().await.remove(&req_id) {
                if let Some(err) = msg.get("error") {
                    let message = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("ACP error");
                    let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-32603);
                    let _ = tx.send(Err(format!("[{code}] {message}")));
                } else {
                    let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(json!({}))));
                }
            }
            return;
        }

        if let (Some(req_id), Some(m)) = (id, method) {
            let mode = self.settings.read().await.mode;
            let result = if m == "session/request_permission" {
                let allow = mode != DevinMode::Ask;
                let opts = msg
                    .get("params")
                    .and_then(|p| p.get("options"))
                    .and_then(|o| o.as_array())
                    .cloned()
                    .unwrap_or_default();
                let picked = if allow {
                    opts.iter()
                        .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("allow_always"))
                        .or_else(|| opts.iter().find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("allow_once")))
                        .or_else(|| opts.first())
                } else {
                    opts.iter()
                        .find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("reject_once"))
                        .or_else(|| opts.iter().find(|o| o.get("kind").and_then(|k| k.as_str()) == Some("reject_always")))
                };
                if let Some(opt_id) = picked.and_then(|o| o.get("optionId")).and_then(|s| s.as_str()) {
                    json!({ "outcome": { "outcome": "selected", "optionId": opt_id } })
                } else {
                    json!({ "outcome": { "outcome": "cancelled" } })
                }
            } else if m == "session/create_elicitation" {
                json!({ "action": "decline" })
            } else {
                json!({})
            };

            let reply = format!("{}\n", json!({ "jsonrpc": "2.0", "id": req_id, "result": result }));
            let mut st = self.proc_state.lock().await;
            if let Some(stdin) = st.stdin.as_mut() {
                let _ = stdin.write_all(reply.as_bytes()).await;
            }
            return;
        }

        if method == Some("session/update") {
            if let Some(params) = msg.get("params") {
                if let (Some(sid), Some(update)) = (
                    params.get("sessionId").and_then(|s| s.as_str()),
                    params.get("update"),
                ) {
                    self.track_tool(sid, update).await;
                    if let Some(tx) = self.session_sinks.lock().await.get(sid).cloned() {
                        let _ = tx.send(update.clone());
                    }
                }
            }
        }
    }

    async fn track_tool(&self, session_id: &str, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "tool_call" && kind != "tool_call_update" {
            return;
        }
        let Some(tool_id) = update.get("toolCallId").and_then(|v| v.as_str()) else {
            return;
        };
        let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("in_progress");
        let key = format!("{session_id}\u{0}{tool_id}");
        let mut map = self.running_tools.lock().await;
        match status {
            "pending" | "in_progress" => {
                map.insert(key, ());
            }
            _ => {
                map.remove(&key);
            }
        }
        self.tools_in_flight.store(map.len(), Ordering::SeqCst);
    }

    async fn clear_tools(&self, session_id: Option<&str>) {
        let mut map = self.running_tools.lock().await;
        match session_id {
            Some(sid) => {
                let prefix = format!("{sid}\u{0}");
                map.retain(|k, _| !k.starts_with(&prefix));
            }
            None => map.clear(),
        }
        self.tools_in_flight.store(map.len(), Ordering::SeqCst);
    }

    async fn handle_process_exit(&self, reason: &str) {
        {
            let mut st = self.proc_state.lock().await;
            st.stdin = None;
            st.initialized = false;
            if let Some(mut child) = st.child.take() {
                let _ = child.kill().await;
            }
        }
        self.sessions.lock().await.clear();
        self.clear_tools(None).await;
        let mut pend = self.pending.lock().await;
        for (_, tx) in pend.drain() {
            let _ = tx.send(Err(format!("{} {reason}", self.cfg.label)));
        }
        if !self.stopping.load(Ordering::SeqCst) {
            (self.log)("warn", &format!("acp:{}", self.cfg.key), reason);
        }
    }

    async fn rpc_request(&self, method: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        {
            let mut st = self.proc_state.lock().await;
            let Some(stdin) = st.stdin.as_mut() else {
                self.pending.lock().await.remove(&id);
                return Err(format!("{} ACP процесс не запущен", self.cfg.label));
            };
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&id);
                return Err(e.to_string());
            }
        }

        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(format!("{} канал RPC закрыт", self.cfg.label)),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{} RPC \"{method}\" таймаут {timeout_ms}мс", self.cfg.label))
            }
        }
    }

    /// Ждёт ответ, считая таймаут по времени молчания, а не по общей длительности.
    /// Пока агент присылает session/update (текст, размышления, вызовы инструментов),
    /// запрос живёт; обрывается только если процесс замолчал на idle_ms.
    async fn rpc_request_idle(&self, method: &str, params: Value, idle_ms: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, mut rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        self.last_msg_ms.store(now_ms(), Ordering::SeqCst);
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        {
            let mut st = self.proc_state.lock().await;
            let Some(stdin) = st.stdin.as_mut() else {
                self.pending.lock().await.remove(&id);
                return Err(format!("{} ACP процесс не запущен", self.cfg.label));
            };
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&id);
                return Err(e.to_string());
            }
        }

        let mut last_report = 0u64;
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(1_000), &mut rx).await {
                Ok(Ok(res)) => return res,
                Ok(Err(_)) => return Err(format!("{} канал RPC закрыт", self.cfg.label)),
                Err(_) => {
                    let busy = self.tools_in_flight.load(Ordering::SeqCst);
                    let limit = if busy > 0 { idle_ms.max(TOOL_IDLE_FLOOR_MS) } else { idle_ms };
                    let silent = now_ms().saturating_sub(self.last_msg_ms.load(Ordering::SeqCst));
                    if silent >= limit {
                        self.pending.lock().await.remove(&id);
                        let hint = if busy > 0 {
                            format!(", инструмент так и не завершился за {} мин", limit / 60_000)
                        } else {
                            String::new()
                        };
                        return Err(format!(
                            "{} молчит {} с (\"{method}\"){hint}: похоже, зависло — попробуйте ещё раз",
                            self.cfg.label,
                            silent / 1000
                        ));
                    }
                    if silent >= 60_000 && silent / 60_000 > last_report {
                        last_report = silent / 60_000;
                        let suffix = if busy > 0 {
                            format!("; выполняется инструмент, лимит продлён до {} мин", limit / 60_000)
                        } else {
                            String::new()
                        };
                        (self.log)(
                            "info",
                            &format!("acp:{}", self.cfg.key),
                            &format!(
                                "{} ждёт ответа {} с: агент не присылает ни текста, ни событий{}",
                                self.cfg.label,
                                silent / 1000,
                                suffix
                            ),
                        );
                    }
                }
            }
        }
    }

    async fn close_session(&self, session_id: &str) {
        if !self.cfg.supports_close_session || !self.is_ready().await {
            return;
        }
        let params = if self.cfg.close_force_meta {
            json!({ "sessionId": session_id, "_meta": { "cognition.ai/force": true } })
        } else {
            json!({ "sessionId": session_id })
        };
        let _ = self.rpc_request("session/close", params, 5_000).await;
    }

    async fn rpc_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        let mut st = self.proc_state.lock().await;
        let Some(stdin) = st.stdin.as_mut() else {
            return Err(format!("{} ACP процесс не запущен", self.cfg.label));
        };
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())
    }

    async fn cancel_session(&self, session_id: &str) {
        if !self.is_ready().await {
            return;
        }
        let _ = self
            .rpc_notification("session/cancel", json!({ "sessionId": session_id }))
            .await;
    }

    fn update_catalog_from(&self, parsed: &crate::models::ParsedConfigCatalog) -> Vec<RawModelEntry> {
        let mut models = parsed.models.clone();
        if let Some((mode, custom)) = &self.cfg.opencode_filter {
            models = filter_opencode_models(&models, *mode, custom);
        }
        models
    }

    pub async fn warm_up(self: &Arc<Self>, force: bool) -> Result<Vec<RawModelEntry>, String> {
        if !force {
            let cached = self.models.read().await;
            if !cached.is_empty() {
                return Ok(cached.clone());
            }
        }
        let _lock = self.warmup_lock.lock().await;
        if !force {
            let cached = self.models.read().await;
            if !cached.is_empty() {
                return Ok(cached.clone());
            }
        }

        let res: Result<Vec<RawModelEntry>, String> = async {
            self.ensure_ready().await?;
            let (default_cwd, startup_ms) = {
                let s = self.settings.read().await;
                (s.cwd.clone(), s.startup_timeout_ms)
            };
            let cwd = self.cfg.discovery_cwd.clone().unwrap_or(default_cwd);

            let mut created = self
                .rpc_request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), startup_ms)
                .await?;
            if let Some(sid) = created.get("sessionId").and_then(|v| v.as_str()) {
                self.close_session(sid).await;
            }
            let mut parsed = parse_config_catalog(
                created.get("configOptions"),
                created.get("models").and_then(|m| m.get("availableModels")),
            );
            let mut models = self.update_catalog_from(&parsed);

            if self.cfg.kind == BackendKind::Opencode
                && !parsed.models.iter().any(|m| m.id.to_lowercase().starts_with("opencode-go/"))
            {
                tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                created = self
                    .rpc_request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), startup_ms)
                    .await?;
                if let Some(sid) = created.get("sessionId").and_then(|v| v.as_str()) {
                    self.close_session(sid).await;
                }
                parsed = parse_config_catalog(
                    created.get("configOptions"),
                    created.get("models").and_then(|m| m.get("availableModels")),
                );
                models = self.update_catalog_from(&parsed);
            }

            if !models.is_empty() {
                *self.models.write().await = models.clone();
            }
            if parsed.thought_config_id.is_some() {
                *self.default_thought_config_id.write().await = parsed.thought_config_id;
            }
            if !parsed.thought_levels.is_empty() {
                *self.default_thought_levels.write().await = parsed.thought_levels;
            }
            if !parsed.thought_wire_values.is_empty() {
                *self.default_thought_wire.write().await = parsed.thought_wire_values;
            }
            if !parsed.modes.is_empty() {
                *self.default_modes.write().await = parsed.modes;
            }
            *self.last_error.write().await = None;
            Ok(models)
        }
        .await;

        if let Err(ref e) = res {
            *self.last_error.write().await = Some(e.clone());
        }
        res
    }

    pub async fn list_models(&self) -> Vec<BackendModelEntry> {
        let models = self.models.read().await;
        let thought_levels = self.default_thought_levels.read().await;
        models
            .iter()
            .map(|m| {
                let qualified_id = if self.cfg.kind == BackendKind::Opencode {
                    let lower = m.id.to_lowercase();
                    if lower.starts_with("opencode-go/") {
                        format!("oc-go.{}", &m.id["opencode-go/".len()..])
                    } else if lower.starts_with("opencode/") {
                        format!("oc-free.{}", &m.id["opencode/".len()..])
                    } else {
                        format!("oc.{}", m.id)
                    }
                } else if self.cfg.qualified_prefix.is_empty() {
                    m.id.clone()
                } else {
                    format!("{}{}", self.cfg.qualified_prefix, m.id)
                };

                let description = if self.cfg.kind == BackendKind::Opencode {
                    let lower = m.id.to_lowercase();
                    if lower.starts_with("opencode-go/") {
                        format!("OpenCode Go: {}", &m.id["opencode-go/".len()..])
                    } else if lower.starts_with("opencode/") {
                        format!("OpenCode: {}", &m.id["opencode/".len()..])
                    } else {
                        format!("OpenCode: {}", m.id)
                    }
                } else {
                    format!("{}: {}", self.cfg.description_prefix, m.id)
                };

                let display_raw = if self.cfg.kind == BackendKind::Opencode {
                    m.name
                        .trim_start_matches("opencode-go/")
                        .trim_start_matches("opencode/")
                        .trim()
                        .to_string()
                } else {
                    crate::models::normalize_tier_display_name(&m.name)
                };

                let gateway_id = if self.cfg.kind == BackendKind::Devin && self.cfg.qualified_prefix.is_empty() {
                    to_gateway_model_id(&m.id, false)
                } else {
                    to_gateway_model_id(&qualified_id, true)
                };

                let is_free = self.cfg.kind != BackendKind::Grok
                    && (self.cfg.kind != BackendKind::Opencode
                        || is_free_opencode_model(&m.id, &m.name)
                        || m.id.to_lowercase().starts_with("opencode-go/"));

                BackendModelEntry {
                    id: qualified_id.clone(),
                    name: display_raw.clone(),
                    display_name: display_raw,
                    gateway_id,
                    supports_images: m.supports_images,
                    description: description.chars().take(100).collect(),
                    backend_key: self.cfg.key.clone(),
                    backend_kind: self.cfg.kind,
                    backend_label: self.cfg.label.clone(),
                    native_id: m.id.clone(),
                    qualified_id,
                    brand: infer_model_brand(&m.id, self.cfg.kind).to_string(),
                    max_input_tokens: infer_max_input_tokens(&m.id),
                    max_tokens: 64_000,
                    supported_efforts: if m.supported_efforts.is_empty() {
                        thought_levels.clone()
                    } else {
                        m.supported_efforts.clone()
                    },
                    supported_speeds: m.supported_speeds.clone(),
                    is_free,
                }
            })
            .collect()
    }

    pub async fn get_status(&self) -> BackendHealthStatus {
        BackendHealthStatus {
            key: self.cfg.key.clone(),
            kind: self.cfg.kind,
            label: self.cfg.label.clone(),
            ready: self.is_ready().await,
            models_count: self.models.read().await.len(),
            active_sessions: self.active_session_count().await,
            error: self.last_error.read().await.clone(),
            executable: Some(self.cfg.executable.clone()),
        }
    }

    pub async fn run_turn(
        self: &Arc<Self>,
        native_model_id: &str,
        req: &UnifiedTurnRequest,
        sink: Option<StreamSink>,
        cancel_notify: Option<Arc<CancelToken>>,
    ) -> Result<TurnResult, String> {
        if self.models.read().await.is_empty() {
            let _ = self.warm_up(false).await;
        } else {
            self.ensure_ready().await?;
        }

        let settings = self.settings.read().await.clone();
        let cwd = req
            .cwd
            .clone()
            .or_else(|| self.cfg.discovery_cwd.clone())
            .unwrap_or_else(|| settings.cwd.clone());
        let sys_hash = hash_system(&req.system);
        let fingerprints: Vec<String> = req
            .messages
            .iter()
            .map(|m| message_fingerprint(&m.role, &m.text, m.images.len()))
            .collect();

        let supports_images = self
            .models
            .read()
            .await
            .iter()
            .find(|m| m.id == native_model_id)
            .map(|m| m.supports_images)
            .unwrap_or(true);

        let matched_id = {
            let mut sessions = self.sessions.lock().await;
            let now = now_ms();
            let expired: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| !s.busy && now.saturating_sub(s.last_used_ms) > settings.idle_session_ttl_ms)
                .map(|(k, _)| k.clone())
                .collect();
            for k in expired {
                sessions.remove(&k);
            }

            let mut best: Option<(String, usize)> = None;
            for (sid, s) in sessions.iter() {
                if s.busy || s.cwd != cwd || s.system_hash != sys_hash {
                    continue;
                }
                let len = s.fingerprints.len();
                if len == 0 || len >= fingerprints.len() {
                    continue;
                }
                if s.fingerprints.iter().zip(fingerprints.iter()).all(|(a, b)| a == b) {
                    if best.as_ref().map(|(_, bl)| len > *bl).unwrap_or(true) {
                        best = Some((sid.clone(), len));
                    }
                }
            }
            best.map(|(id, _)| id)
        };

        let (mut session, is_fresh) = if let Some(sid) = matched_id {
            let mut sessions = self.sessions.lock().await;
            if let Some(s) = sessions.get_mut(&sid) {
                s.busy = true;
                s.last_used_ms = now_ms();
                (s.clone(), false)
            } else {
                drop(sessions);
                let created = self.create_session(&cwd, &sys_hash, &settings).await?;
                (created, true)
            }
        } else {
            let created = self.create_session(&cwd, &sys_hash, &settings).await?;
            (created, true)
        };

        let mode_list = if session.supported_modes.is_empty() {
            self.default_modes.read().await.clone()
        } else {
            session.supported_modes.clone()
        };
        if let Some(target_mode) = map_mode_for_backend(self.cfg.kind, settings.mode, &mode_list) {
            if session.mode.as_deref() != Some(&target_mode) {
                if let Ok(upd) = self
                    .rpc_request(
                        "session/set_config_option",
                        json!({ "sessionId": session.id, "configId": "mode", "value": target_mode }),
                        15_000,
                    )
                    .await
                {
                    let p = parse_config_catalog(upd.get("configOptions"), None);
                    if !p.thought_levels.is_empty() {
                        session.supported_thought_levels = p.thought_levels;
                    }
                    if !p.thought_wire_values.is_empty() {
                        session.thought_wire_values.extend(p.thought_wire_values);
                    }
                    session.mode = Some(target_mode);
                }
            }
        }

        if session.model.as_deref() != Some(native_model_id) {
            let upd = self
                .rpc_request(
                    "session/set_config_option",
                    json!({ "sessionId": session.id, "configId": "model", "value": native_model_id }),
                    15_000,
                )
                .await?;
            let p = parse_config_catalog(upd.get("configOptions"), None);
            if let Some(tid) = p.thought_config_id {
                session.thought_config_id = Some(tid);
            }
            if !p.thought_levels.is_empty() {
                session.supported_thought_levels = p.thought_levels;
            }
            if !p.thought_wire_values.is_empty() {
                session.thought_wire_values.extend(p.thought_wire_values);
            }
            if !p.speeds.is_empty() {
                session.supported_speeds = p.speeds;
            }
            session.model = Some(native_model_id.to_string());
        }

        let thought_id = session
            .thought_config_id
            .or(*self.default_thought_config_id.read().await);
        let supported_efforts = if session.supported_thought_levels.is_empty() {
            self.default_thought_levels.read().await.clone()
        } else {
            session.supported_thought_levels.clone()
        };
        let target_effort = resolve_thought_level(
            req.requested_effort,
            None,
            req.thinking_disabled,
            req.thinking_budget,
            settings.thought_level,
            &supported_efforts,
        );
        if let (Some(cid), Some(eff)) = (thought_id, target_effort) {
            if session.thought_level != Some(eff) {
                let wire = session
                    .thought_wire_values
                    .get(&eff)
                    .cloned()
                    .or_else(|| self.default_thought_wire.try_read().ok().and_then(|w| w.get(&eff).cloned()))
                    .unwrap_or_else(|| eff.as_str().to_string());
                if self
                    .rpc_request(
                        "session/set_config_option",
                        json!({ "sessionId": session.id, "configId": cid.as_str(), "value": wire }),
                        15_000,
                    )
                    .await
                    .is_ok()
                {
                    session.thought_level = Some(eff);
                }
            }
        }

        if let Some(spd) = resolve_speed(req.requested_speed, settings.speed, &session.supported_speeds) {
            if session.speed != Some(spd) {
                if self
                    .rpc_request(
                        "session/set_config_option",
                        json!({ "sessionId": session.id, "configId": "speed", "value": spd.as_str() }),
                        15_000,
                    )
                    .await
                    .is_ok()
                {
                    session.speed = Some(spd);
                }
            }
        }

        let delta = if is_fresh {
            &req.messages[..]
        } else {
            &req.messages[session.fingerprints.len()..]
        };

        let mut blocks: Vec<Value> = Vec::new();
        let mut text_chunks: Vec<String> = Vec::new();
        let mut images: Vec<Value> = Vec::new();

        if is_fresh && !req.system.trim().is_empty() {
            text_chunks.push(format!("<system_instructions>\n{}\n</system_instructions>", req.system.trim()));
        }
        if delta.len() == 1 && delta[0].role == "user" {
            if !delta[0].text.is_empty() {
                text_chunks.push(delta[0].text.clone());
            }
            for img in &delta[0].images {
                images.push(json!({ "type": "image", "data": img.data, "mimeType": img.mime_type }));
            }
        } else {
            for m in delta {
                let lbl = if m.role == "assistant" { "Assistant" } else { "User" };
                if !m.text.is_empty() {
                    text_chunks.push(format!("[{lbl}]\n{}", m.text));
                }
                for img in &m.images {
                    images.push(json!({ "type": "image", "data": img.data, "mimeType": img.mime_type }));
                }
            }
        }
        if !images.is_empty() && !supports_images {
            text_chunks.push(format!(
                "[{} image attachment(s) omitted because selected model does not support images]",
                images.len()
            ));
            images.clear();
        }
        if !text_chunks.is_empty() {
            blocks.push(json!({ "type": "text", "text": text_chunks.join("\n\n") }));
        }
        blocks.extend(images);
        if blocks.is_empty() {
            blocks.push(json!({ "type": "text", "text": "Continue." }));
        }

        let (upd_tx, mut upd_rx) = mpsc::unbounded_channel::<Value>();
        self.session_sinks
            .lock()
            .await
            .insert(session.id.clone(), upd_tx);

        let sid_clone = session.id.clone();
        let sink_clone = sink.clone();
        let show_tools = settings.show_tools;
        let backend_label = self.cfg.label.clone();

        let collector = tokio::spawn(async move {
            let mut assistant_text = String::new();
            let mut thinking_text = String::new();
            let mut input_tokens = 0u64;
            let mut output_tokens = 0u64;
            let mut cache_read_tokens = 0u64;
            let mut measured = false;
            let mut tool_activity = ToolActivityTracker::new();
            let mut plan_activity = PlanActivityTracker::new();

            while let Some(upd) = upd_rx.recv().await {
                let kind = upd.get("sessionUpdate").and_then(|v| v.as_str()).unwrap_or("");
                if kind == "usage_update" {
                    let meta = upd.get("_meta");
                    let inp = meta
                        .and_then(|m| m.get("cognition.ai/inputTokens"))
                        .or_else(|| upd.get("used"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let out = meta
                        .and_then(|m| m.get("cognition.ai/outputTokens"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cached = meta
                        .and_then(|m| {
                            m.get("cognition.ai/cacheReadTokens")
                                .or_else(|| m.get("cognition.ai/cachedReadTokens"))
                        })
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if inp > 0 || out > 0 {
                        input_tokens = inp;
                        output_tokens = out;
                        cache_read_tokens = cached;
                        measured = true;
                        if let Some(s) = &sink_clone {
                            let _ = s.send(StreamEvent::Usage {
                                input_tokens,
                                output_tokens,
                            });
                        }
                    }
                } else if kind == "agent_thought_chunk" {
                    if let Some(txt) = upd.get("content").and_then(|c| c.get("text")).and_then(|t| t.as_str()) {
                        thinking_text.push_str(txt);
                        if let Some(s) = &sink_clone {
                            let _ = s.send(StreamEvent::Thinking(txt.to_string()));
                        }
                    }
                } else if kind == "agent_message_chunk" {
                    if let Some(txt) = upd.get("content").and_then(|c| c.get("text")).and_then(|t| t.as_str()) {
                        assistant_text.push_str(txt);
                        if let Some(s) = &sink_clone {
                            let _ = s.send(StreamEvent::Text(txt.to_string()));
                        }
                    }
                } else if kind == "tool_call_content_chunk" {
                    if show_tools != crate::types::ShowToolsMode::None {
                        tool_activity.note_acp_content_chunk(&upd);
                    }
                } else if (kind == "tool_call"
                        || kind == "tool_call_update"
                        || kind == "plan_update"
                        || kind == "plan"
                        || kind == "plan_removed")
                    && show_tools != crate::types::ShowToolsMode::None
                {
                    let hidden_hook = upd
                        .get("_meta")
                        .and_then(|meta| meta.get("cognition.ai/eventType"))
                        .and_then(|v| v.as_str())
                        == Some("hook_execution")
                        && upd.get("status").and_then(|v| v.as_str()) != Some("failed");
                    let line = if hidden_hook {
                        None
                    } else if kind == "plan_update" || kind == "plan" || kind == "plan_removed" {
                        plan_activity.acp_plan_line(&backend_label, &upd)
                    } else {
                        tool_activity.acp_tool_line(&backend_label, &upd)
                    };
                    if let Some(line) = line {
                        if show_tools == crate::types::ShowToolsMode::Text {
                            assistant_text.push_str(&line);
                            if let Some(s) = &sink_clone {
                                let _ = s.send(StreamEvent::Text(line));
                            }
                        } else {
                            thinking_text.push_str(&line);
                            if let Some(s) = &sink_clone {
                                let _ = s.send(StreamEvent::Thinking(line));
                            }
                        }
                    }
                }
            }
            (
                assistant_text,
                thinking_text,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                measured,
            )
        });

        let prompt_fut = self.rpc_request_idle(
            "session/prompt",
            json!({ "sessionId": sid_clone, "prompt": blocks }),
            settings.request_timeout_ms,
        );

        let prompt_res = if let Some(notify) = cancel_notify {
            tokio::select! {
                res = prompt_fut => res,
                _ = notify.cancelled() => {
                    self.cancel_session(&sid_clone).await;
                    Err("Запрос отменён пользователем".to_string())
                }
            }
        } else {
            prompt_fut.await
        };

        self.session_sinks.lock().await.remove(&sid_clone);
        self.clear_tools(Some(&sid_clone)).await;
        let (assistant_text, thinking_text, mut input_tokens, mut output_tokens, mut cache_read_tokens, mut measured) =
            collector.await.unwrap_or_default();

        match prompt_res {
            Ok(res) => {
                if let Some(usage) = res.get("usage") {
                    let inp = usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let out = usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cached = usage
                        .get("cacheReadTokens")
                        .or_else(|| usage.get("cache_read_input_tokens"))
                        .or_else(|| usage.get("cachedInputTokens"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if inp > 0 || out > 0 {
                        input_tokens = inp;
                        output_tokens = out;
                        cache_read_tokens = cached;
                        measured = true;
                    }
                }

                let mut new_fps = fingerprints;
                new_fps.push(message_fingerprint("assistant", &assistant_text, 0));
                session.fingerprints = new_fps;
                session.busy = false;
                session.last_used_ms = now_ms();
                self.sessions.lock().await.insert(session.id.clone(), session);

                let stop_reason = match res.get("stopReason").and_then(|v| v.as_str()) {
                    Some("max_tokens") | Some("max_turn_requests") => "max_tokens",
                    Some("refusal") => "refusal",
                    _ => "end_turn",
                }
                .to_string();

                let thinking_tokens = crate::pricing::estimate_tokens_from_chars(thinking_text.len());
                Ok(TurnResult {
                    model_id: native_model_id.to_string(),
                    stop_reason,
                    usage: TurnUsage {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        thinking_tokens,
                        measured,
                    },
                    assistant_text,
                    thinking_text,
                })
            }
            Err(e) => {
                self.sessions.lock().await.remove(&sid_clone);
                Err(e)
            }
        }
    }

    async fn create_session(
        &self,
        cwd: &str,
        sys_hash: &str,
        settings: &AppSettings,
    ) -> Result<SessionRecord, String> {
        {
            let mut sessions = self.sessions.lock().await;
            while sessions.len() >= settings.max_sessions {
                let oldest = sessions
                    .values()
                    .filter(|s| !s.busy)
                    .min_by_key(|s| s.last_used_ms)
                    .map(|s| s.id.clone());
                let Some(oid) = oldest else { break };
                sessions.remove(&oid);
            }
        }

        let created = self
            .rpc_request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                settings.startup_timeout_ms,
            )
            .await?;
        let sid = created
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or("ACP session/new missing sessionId")?
            .to_string();
        let parsed = parse_config_catalog(
            created.get("configOptions"),
            created.get("models").and_then(|m| m.get("availableModels")),
        );
        let rec = SessionRecord {
            id: sid.clone(),
            cwd: cwd.to_string(),
            system_hash: sys_hash.to_string(),
            fingerprints: Vec::new(),
            model: parsed.current_model,
            mode: parsed.current_mode,
            thought_level: parsed.current_thought_level,
            thought_config_id: parsed.thought_config_id,
            thought_wire_values: parsed.thought_wire_values,
            speed: parsed.current_speed,
            supported_modes: parsed.modes,
            supported_thought_levels: parsed.thought_levels,
            supported_speeds: parsed.speeds,
            busy: true,
            last_used_ms: now_ms(),
        };
        self.sessions.lock().await.insert(sid, rec.clone());
        Ok(rec)
    }

    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let sids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for sid in sids {
            self.close_session(&sid).await;
        }
        self.sessions.lock().await.clear();
        let mut st = self.proc_state.lock().await;
        st.stdin = None;
        st.initialized = false;
        if let Some(mut child) = st.child.take() {
            let _ = child.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn test_backend() -> Arc<AcpBackend> {
        let settings = Arc::new(RwLock::new(AppSettings::default()));
        let log: LogFn = Arc::new(|_, _, _| {});
        AcpBackend::new(
            AcpEndpointConfig {
                key: "test".into(),
                kind: BackendKind::Devin,
                label: "Test ACP".into(),
                executable: "unused-in-test".into(),
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
        )
    }

    #[tokio::test]
    async fn cancel_session_sends_acp_notification_without_request_id() {
        let backend = test_backend();
        let (writer, mut reader) = tokio::io::duplex(1024);
        {
            let mut st = backend.proc_state.lock().await;
            st.stdin = Some(Box::new(writer));
            st.initialized = true;
        }

        let cancel_backend = backend.clone();
        let cancel_task = tokio::spawn(async move {
            cancel_backend.cancel_session("sess-1").await;
        });

        let mut buf = vec![0u8; 1024];
        let n = tokio::time::timeout(std::time::Duration::from_secs(1), reader.read(&mut buf))
            .await
            .expect("cancel frame was not written")
            .expect("cancel pipe read failed");
        let frame: Value = serde_json::from_slice(&buf[..n]).expect("cancel frame is not JSON");
        assert_eq!(frame["method"], "session/cancel");
        assert_eq!(frame["params"]["sessionId"], "sess-1");
        assert!(
            frame.get("id").is_none(),
            "session/cancel must be an ACP notification, not a request: {frame}"
        );

        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), cancel_task).await;
    }
}

#[cfg(test)]
mod cancel_integration_tests {
    use super::*;
    use crate::types::NormalizedMessage;
    use std::io::{BufRead as StdBufRead, Write as StdWrite};

    fn write_json_line(stdout: &mut impl StdWrite, value: Value) {
        let mut line = value.to_string();
        line.push('\n');
        let _ = stdout.write_all(line.as_bytes());
        let _ = stdout.flush();
    }

    fn write_child_response(stdout: &mut impl StdWrite, id: Value, result: Value) {
        write_json_line(stdout, json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn append_child_event(path: &str, event: &str) {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{event}");
            let _ = file.flush();
        }
    }

    /// Вспомогательный вход в тестовом бинарнике: при установленной env-переменной
    /// процесс работает как минимальный ACP agent поверх stdio.
    #[test]
    fn fake_acp_cancel_child() {
        if std::env::var("AI_PROXY_FAKE_ACP_CHILD").is_err() {
            return;
        }
        let events_path = std::env::var("AI_PROXY_FAKE_ACP_EVENTS").unwrap_or_default();
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        let mut prompt_id: Option<Value> = None;

        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let method = msg.get("method").and_then(|v| v.as_str());
            let id = msg.get("id").cloned();
            match method {
                Some("initialize") => {
                    if let Some(id) = id {
                        write_child_response(&mut stdout, id, json!({ "protocolVersion": 1, "authMethods": [] }));
                    }
                }
                Some("session/new") => {
                    if let Some(id) = id {
                        write_child_response(&mut stdout, id, json!({
                            "sessionId": "fake-session",
                            "configOptions": [
                                {
                                    "id": "model",
                                    "currentValue": "fake-model",
                                    "options": [{ "value": "fake-model", "name": "Fake Model" }]
                                },
                                {
                                    "id": "mode",
                                    "currentValue": "bypass",
                                    "options": [{ "value": "bypass", "name": "Bypass" }]
                                }
                            ]
                        }));
                    }
                }
                Some("session/set_config_option") => {
                    if let Some(id) = id {
                        write_child_response(&mut stdout, id, json!({ "configOptions": [] }));
                    }
                }
                Some("session/prompt") => {
                    prompt_id = id;
                    append_child_event(&events_path, "prompt");
                    write_json_line(&mut stdout, json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": "fake-session",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "working" }
                            }
                        }
                    }));
                }
                Some("session/cancel") => {
                    append_child_event(
                        &events_path,
                        if id.is_some() { "cancel-request" } else { "cancel-notification" },
                    );
                    if let Some(cancel_id) = id {
                        write_child_response(&mut stdout, cancel_id, json!({}));
                    }
                    if let Some(pid) = prompt_id.take() {
                        write_child_response(&mut stdout, pid, json!({ "stopReason": "cancelled" }));
                    }
                }
                Some("session/close") => {
                    if let Some(id) = id {
                        write_child_response(&mut stdout, id, json!({}));
                    }
                }
                _ => {
                    if let Some(id) = id {
                        write_child_response(&mut stdout, id, json!({}));
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn cancel_token_sends_acp_cancel_notification() {
        let mut env = HashMap::new();
        env.insert("AI_PROXY_FAKE_ACP_CHILD".to_string(), Some("1".to_string()));
        let events_path = std::env::temp_dir()
            .join(format!("ai-proxy-acp-cancel-{}.log", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .to_string();
        env.insert("AI_PROXY_FAKE_ACP_EVENTS".to_string(), Some(events_path.clone()));

        let exe = std::env::current_exe().expect("current test executable");
        let cfg = AcpEndpointConfig {
            key: "fake-acp".into(),
            kind: BackendKind::Custom,
            label: "Fake ACP".into(),
            executable: exe.to_string_lossy().to_string(),
            args: vec![
                "--nocapture".into(),
                "--exact".into(),
                "acp_client::cancel_integration_tests::fake_acp_cancel_child".into(),
            ],
            env_overrides: env,
            auth_method_ids: Vec::new(),
            supports_close_session: true,
            close_force_meta: false,
            qualified_prefix: "fake.".into(),
            description_prefix: "Fake".into(),
            opencode_filter: None,
            discovery_cwd: None,
        };

        let app_settings = AppSettings {
            startup_timeout_ms: 5_000,
            request_timeout_ms: 5_000,
            ..Default::default()
        };
        let settings = Arc::new(RwLock::new(app_settings));
        let log: LogFn = Arc::new(|_, _, _| {});
        let backend = AcpBackend::new(cfg, settings, log);
        backend.models.write().await.push(RawModelEntry {
            id: "fake-model".into(),
            name: "Fake Model".into(),
            supports_images: true,
            description: None,
            supported_efforts: Vec::new(),
            effort_wire_values: HashMap::new(),
            default_effort: None,
            supported_speeds: Vec::new(),
        });

        let (sink, mut stream_rx) = mpsc::unbounded_channel();
        let cancel = CancelToken::new();
        let backend_for_turn = backend.clone();
        let cancel_for_turn = cancel.clone();
        let turn_task = tokio::spawn(async move {
            let req = UnifiedTurnRequest {
                model: Some("fake-model".into()),
                system: String::new(),
                messages: vec![NormalizedMessage {
                    role: "user".into(),
                    text: "start".into(),
                    images: Vec::new(),
                }],
                requested_effort: None,
                thinking_disabled: false,
                thinking_budget: None,
                requested_speed: None,
                cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
            };
            backend_for_turn
                .run_turn("fake-model", &req, Some(sink), Some(cancel_for_turn))
                .await
        });

        let first_event = tokio::time::timeout(std::time::Duration::from_secs(5), stream_rx.recv())
            .await
            .expect("fake ACP did not start streaming")
            .expect("stream closed before the first chunk");
        assert!(matches!(first_event, StreamEvent::Text(ref chunk) if chunk == "working"));

        cancel.cancel();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut saw_notification = false;
        while std::time::Instant::now() < deadline {
            if std::fs::read_to_string(&events_path)
                .map(|contents| contents.lines().any(|line| line == "cancel-notification"))
                .unwrap_or(false)
            {
                saw_notification = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            saw_notification,
            "ACP cancel must be sent as a JSON-RPC notification (without id); events: {:?}",
            std::fs::read_to_string(&events_path).unwrap_or_default()
        );

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), turn_task)
            .await
            .expect("cancelled turn did not finish")
            .expect("turn task panicked");
        assert!(outcome.is_err(), "cancelled turn unexpectedly succeeded");

        backend.shutdown().await;
    }
}
