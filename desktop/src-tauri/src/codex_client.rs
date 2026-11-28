use crate::acp_client::{hash_system, message_fingerprint, LogFn, StreamEvent, StreamSink};
use crate::cancel::CancelToken;
use crate::models::{
    infer_max_input_tokens, normalize_effort_value, resolve_speed, resolve_thought_level,
    to_gateway_model_id,
};
use crate::types::{
    AppSettings, BackendHealthStatus, BackendKind, BackendModelEntry, DevinMode, RawModelEntry,
    SpeedMode, TurnResult, TurnUsage, UnifiedTurnRequest,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex, RwLock};

struct CodexInner {
    child: Option<Child>,
    stdin: Option<Box<dyn AsyncWrite + Unpin + Send>>,
    initialized: bool,
}

#[derive(Clone)]
struct ThreadRecord {
    thread_id: String,
    cwd: String,
    system_hash: String,
    fingerprints: Vec<String>,
    busy: bool,
    last_used_ms: u64,
}

struct TurnState {
    turn_id: Option<String>,
    assistant_text: String,
    thinking_text: String,
    commentary_items: HashSet<String>,
    seen_tools: HashMap<String, String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    measured: bool,
    sink: Option<StreamSink>,
    done_tx: Option<oneshot::Sender<Result<(), String>>>,
}

pub struct CodexBackend {
    pub executable: String,
    settings: Arc<RwLock<AppSettings>>,
    log: LogFn,
    proc_state: Arc<Mutex<CodexInner>>,
    ready_lock: Arc<Mutex<()>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    models: Arc<RwLock<Vec<RawModelEntry>>>,
    threads: Arc<Mutex<HashMap<String, ThreadRecord>>>,
    active_turns: Arc<Mutex<HashMap<String, TurnState>>>,
    warmup_lock: Arc<Mutex<()>>,
    last_error: Arc<RwLock<Option<String>>>,
    stopping: AtomicBool,
    last_msg_ms: Arc<AtomicU64>,
    tools_in_flight: Arc<AtomicUsize>,
    running_tools: Arc<Mutex<HashMap<String, ()>>>,
}

/// Пока инструмент выполняется (сборка, тесты, длинная команда), Codex
/// законно молчит. На это время лимит тишины не ниже получаса.
const TOOL_IDLE_FLOOR_MS: u64 = 30 * 60_000;

fn now_ms() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

fn map_codex_sandbox(mode: DevinMode) -> (&'static str, &'static str) {
    match mode {
        DevinMode::Ask => ("read-only", "on-request"),
        DevinMode::Plan => ("read-only", "never"),
        DevinMode::AcceptEdits | DevinMode::Smart => ("workspace-write", "never"),
        DevinMode::Bypass => ("danger-full-access", "never"),
    }
}

fn describe_codex_tool(item: &Value) -> String {
    let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("tool");
    match kind {
        "commandExecution" => item
            .get("command")
            .and_then(|v| v.as_str())
            .map(|c| format!("Run {}", c.chars().take(80).collect::<String>()))
            .unwrap_or_else(|| "Run command".to_string()),
        "fileChange" => "Edit files".to_string(),
        "mcpToolCall" => {
            let server = item.get("server").and_then(|v| v.as_str()).unwrap_or("");
            let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("mcp");
            if server.is_empty() {
                tool.to_string()
            } else {
                format!("{server}.{tool}")
            }
        }
        "webSearch" => item
            .get("query")
            .and_then(|v| v.as_str())
            .map(|q| format!("Web search: {}", q.chars().take(60).collect::<String>()))
            .unwrap_or_else(|| "Web search".to_string()),
        "dynamicToolCall" => item
            .get("tool")
            .and_then(|v| v.as_str())
            .unwrap_or("Tool call")
            .to_string(),
        other => other.to_string(),
    }
}

impl CodexBackend {
    pub fn new(executable: String, settings: Arc<RwLock<AppSettings>>, log: LogFn) -> Arc<Self> {
        Arc::new(Self {
            executable,
            settings,
            log,
            proc_state: Arc::new(Mutex::new(CodexInner {
                child: None,
                stdin: None,
                initialized: false,
            })),
            ready_lock: Arc::new(Mutex::new(())),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            models: Arc::new(RwLock::new(Vec::new())),
            threads: Arc::new(Mutex::new(HashMap::new())),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            warmup_lock: Arc::new(Mutex::new(())),
            last_error: Arc::new(RwLock::new(None)),
            stopping: AtomicBool::new(false),
            last_msg_ms: Arc::new(AtomicU64::new(0)),
            tools_in_flight: Arc::new(AtomicUsize::new(0)),
            running_tools: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn is_ready(&self) -> bool {
        let g = self.proc_state.lock().await;
        g.initialized && g.stdin.is_some()
    }

    pub async fn active_session_count(&self) -> usize {
        self.threads.lock().await.len()
    }

    async fn ensure_ready(self: &Arc<Self>) -> Result<(), String> {
        if self.is_ready().await {
            return Ok(());
        }
        let _g = self.ready_lock.lock().await;
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
            "codex",
            &format!("Запуск {} app-server --listen stdio://", self.executable),
        );

        let mut cmd = Command::new(&self.executable);
        cmd.args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        {
            let proxy = self.settings.read().await.proxy_url.clone();
            crate::net::apply_proxy_env(&mut cmd, proxy.as_deref(), &std::collections::HashMap::new());
        }
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Не удалось запустить Codex: {e}"))?;
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
            let settings = self.settings.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err_stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && settings.read().await.debug {
                        log("debug", "codex", trimmed);
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
                if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                    this.last_msg_ms.store(now_ms(), Ordering::SeqCst);
                    this.handle_incoming(msg).await;
                }
            }
            this.handle_exit("Codex stdout closed").await;
        });

        self.rpc_request(
            "initialize",
            json!({
                "clientInfo": { "name": "ai-proxy-desktop", "title": "AI Proxy", "version": "0.1.0" },
                "capabilities": { "experimentalApi": true }
            }),
            startup_ms,
        )
        .await?;

        self.proc_state.lock().await.initialized = true;
        Ok(())
    }

    async fn handle_incoming(&self, msg: Value) {
        let id = msg.get("id").and_then(|v| v.as_u64());
        let method = msg.get("method").and_then(|v| v.as_str());

        if let (Some(req_id), None) = (id, method) {
            if let Some(tx) = self.pending.lock().await.remove(&req_id) {
                if let Some(err) = msg.get("error") {
                    let m = err.get("message").and_then(|x| x.as_str()).unwrap_or("Codex RPC error");
                    let _ = tx.send(Err(m.to_string()));
                } else {
                    let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(json!({}))));
                }
            }
            return;
        }

        if let (Some(req_id), Some(m)) = (id, method) {
            let allow = self.settings.read().await.mode != DevinMode::Ask;
            let result = match m {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    json!({ "decision": if allow { "accept" } else { "decline" } })
                }
                "execCommandApproval" | "applyPatchApproval" => {
                    json!({ "decision": if allow { "approved" } else { "denied" } })
                }
                "item/tool/requestUserInput" => json!({ "answers": {} }),
                "mcpServer/elicitation/request" => json!({ "action": "decline" }),
                _ => json!({}),
            };
            let reply = format!("{}\n", json!({ "jsonrpc": "2.0", "id": req_id, "result": result }));
            if let Some(stdin) = self.proc_state.lock().await.stdin.as_mut() {
                let _ = stdin.write_all(reply.as_bytes()).await;
            }
            return;
        }

        if let Some(m) = method {
            let params = msg.get("params").cloned().unwrap_or(json!({}));
            self.handle_notification(m, &params).await;
        }
    }

    async fn track_tool_item(&self, method: &str, params: &Value) {
        if method != "item/started" && method != "item/completed" {
            return;
        }
        let Some(item) = params.get("item") else {
            return;
        };
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if item_type.is_empty() || item_type == "agentMessage" || item_type == "reasoning" {
            return;
        }
        let key = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(item_type)
            .to_string();
        let mut map = self.running_tools.lock().await;
        if method == "item/started" {
            map.insert(key, ());
        } else {
            map.remove(&key);
        }
        self.tools_in_flight.store(map.len(), Ordering::SeqCst);
    }

    async fn handle_notification(&self, method: &str, params: &Value) {
        self.track_tool_item(method, params).await;
        let Some(thread_id) = params.get("threadId").and_then(|v| v.as_str()) else {
            return;
        };
        let show_tools = self.settings.read().await.show_tools;
        let mut turns = self.active_turns.lock().await;
        let Some(active) = turns.get_mut(thread_id) else {
            return;
        };

        match method {
            "turn/started" => {
                if let Some(tid) = params.get("turn").and_then(|t| t.get("id")).and_then(|v| v.as_str()) {
                    active.turn_id = Some(tid.to_string());
                }
            }
            "item/reasoning/summaryPartAdded" => {
                active.thinking_text.push_str("\n\n");
                if let Some(s) = &active.sink {
                    let _ = s.send(StreamEvent::Thinking("\n\n".to_string()));
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                    active.thinking_text.push_str(delta);
                    if let Some(s) = &active.sink {
                        let _ = s.send(StreamEvent::Thinking(delta.to_string()));
                    }
                }
            }
            "item/agentMessage/delta" => {
                if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                    let item_id = params.get("itemId").and_then(|v| v.as_str()).unwrap_or("");
                    if !item_id.is_empty() && active.commentary_items.contains(item_id) {
                        active.thinking_text.push_str(delta);
                        if let Some(s) = &active.sink {
                            let _ = s.send(StreamEvent::Thinking(delta.to_string()));
                        }
                    } else {
                        active.assistant_text.push_str(delta);
                        if let Some(s) = &active.sink {
                            let _ = s.send(StreamEvent::Text(delta.to_string()));
                        }
                    }
                }
            }
            "item/started" | "item/completed" => {
                if let Some(item) = params.get("item") {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or(item_type);
                    if item_type == "agentMessage" {
                        if item.get("phase").and_then(|v| v.as_str()) == Some("commentary") {
                            active.commentary_items.insert(item_id.to_string());
                        } else if method == "item/completed" && active.assistant_text.is_empty() {
                            if let Some(txt) = item.get("text").and_then(|v| v.as_str()) {
                                active.assistant_text = txt.to_string();
                                if let Some(s) = &active.sink {
                                    let _ = s.send(StreamEvent::Text(txt.to_string()));
                                }
                            }
                        }
                    } else if show_tools != crate::types::ShowToolsMode::None
                        && matches!(
                            item_type,
                            "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "dynamicToolCall"
                        )
                    {
                        let title = describe_codex_tool(item);
                        let status = item
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or(if method == "item/completed" { "completed" } else { "in_progress" });
                        if active.seen_tools.get(item_id).map(|s| s.as_str()) != Some(status) {
                            active.seen_tools.insert(item_id.to_string(), status.to_string());
                            let line = if method == "item/started" {
                                format!("\n[Codex tool] {title}...\n")
                            } else {
                                format!("\n[Codex tool {status}] {title}\n")
                            };
                            if show_tools == crate::types::ShowToolsMode::Text {
                                active.assistant_text.push_str(&line);
                                if let Some(s) = &active.sink {
                                    let _ = s.send(StreamEvent::Text(line));
                                }
                            } else {
                                active.thinking_text.push_str(&line);
                                if let Some(s) = &active.sink {
                                    let _ = s.send(StreamEvent::Thinking(line));
                                }
                            }
                        }
                    }
                }
            }
            "thread/tokenUsage/updated" => {
                if let Some(total) = params.get("tokenUsage").and_then(|t| t.get("total")) {
                    let inp = total.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let out = total.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cached = total
                        .get("cachedInputTokens")
                        .or_else(|| {
                            total
                                .get("inputTokensDetails")
                                .and_then(|d| d.get("cachedTokens"))
                        })
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    active.input_tokens = inp;
                    active.output_tokens = out;
                    active.cache_read_tokens = cached;
                    active.measured = true;
                    if let Some(s) = &active.sink {
                        let _ = s.send(StreamEvent::Usage {
                            input_tokens: inp,
                            output_tokens: out,
                        });
                    }
                }
            }
            "turn/completed" => {
                let turn = params.get("turn");
                let cid = turn.and_then(|t| t.get("id")).and_then(|v| v.as_str());
                if let (Some(expected), Some(actual)) = (&active.turn_id, cid) {
                    if expected != actual {
                        return;
                    }
                }
                let status = turn.and_then(|t| t.get("status")).and_then(|v| v.as_str()).unwrap_or("completed");
                if let Some(tx) = active.done_tx.take() {
                    if status == "failed" {
                        let msg = turn
                            .and_then(|t| t.get("error"))
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Codex turn failed");
                        let _ = tx.send(Err(msg.to_string()));
                    } else {
                        let _ = tx.send(Ok(()));
                    }
                }
            }
            _ => {}
        }
    }

    async fn handle_exit(&self, reason: &str) {
        {
            let mut st = self.proc_state.lock().await;
            st.stdin = None;
            st.initialized = false;
            if let Some(mut c) = st.child.take() {
                let _ = c.kill().await;
            }
        }
        self.threads.lock().await.clear();
        self.running_tools.lock().await.clear();
        self.tools_in_flight.store(0, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err(reason.to_string()));
        }
        for (_, mut turn) in self.active_turns.lock().await.drain() {
            if let Some(tx) = turn.done_tx.take() {
                let _ = tx.send(Err(reason.to_string()));
            }
        }
        if !self.stopping.load(Ordering::SeqCst) {
            (self.log)("warn", "codex", reason);
        }
    }

    async fn interrupt_active_turn(&self, thread_id: &str) {
        let turn_id = self
            .active_turns
            .lock()
            .await
            .get(thread_id)
            .and_then(|active| active.turn_id.clone());
        if let Some(tid) = turn_id {
            let _ = self
                .rpc_request(
                    "turn/interrupt",
                    json!({ "threadId": thread_id, "turnId": tid }),
                    5_000,
                )
                .await;
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
                return Err("Codex app-server не запущен".to_string());
            };
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&id);
                return Err(e.to_string());
            }
        }

        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Codex канал RPC закрыт".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("Codex RPC \"{method}\" таймаут {timeout_ms}мс"))
            }
        }
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
            let startup_ms = self.settings.read().await.startup_timeout_ms;
            let raw = self.rpc_request("model/list", json!({ "limit": 100 }), startup_ms).await?;
            let mut parsed = Vec::new();
            if let Some(arr) = raw.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    let Some(id) = item
                        .get("model")
                        .or_else(|| item.get("id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                    else {
                        continue;
                    };
                    let display = item
                        .get("displayName")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let desc = item
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let supports_images = item
                        .get("inputModalities")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().any(|x| x.as_str() == Some("image")))
                        .unwrap_or(true);
                    let mut efforts = Vec::new();
                    let mut wire_map = HashMap::new();
                    if let Some(raw_effs) = item.get("supportedReasoningEfforts").and_then(|v| v.as_array()) {
                        for e in raw_effs {
                            if let Some(wire) = e.get("reasoningEffort").and_then(|v| v.as_str()) {
                                if let Some(norm) = normalize_effort_value(Some(wire)) {
                                    if !efforts.contains(&norm) {
                                        efforts.push(norm);
                                    }
                                    wire_map.insert(norm, wire.to_string());
                                }
                            }
                        }
                    }
                    let mut speeds = vec![SpeedMode::Standard];
                    if let Some(raw_spd) = item.get("additionalSpeedTiers").and_then(|v| v.as_array()) {
                        for s in raw_spd {
                            match s.as_str() {
                                Some("fast") => speeds.push(SpeedMode::Fast),
                                Some("ultrafast") => speeds.push(SpeedMode::Ultrafast),
                                _ => {}
                            }
                        }
                    }
                    parsed.push(RawModelEntry {
                        id,
                        name: display,
                        supports_images,
                        description: desc,
                        supported_efforts: efforts,
                        effort_wire_values: wire_map,
                        default_effort: normalize_effort_value(
                            item.get("defaultReasoningEffort").and_then(|v| v.as_str()),
                        ),
                        supported_speeds: speeds,
                    });
                }
            }
            if !parsed.is_empty() {
                *self.models.write().await = parsed.clone();
            }
            *self.last_error.write().await = None;
            Ok(parsed)
        }
        .await;

        if let Err(ref e) = res {
            *self.last_error.write().await = Some(e.clone());
        }
        res
    }

    pub async fn list_models(&self) -> Vec<BackendModelEntry> {
        self.models
            .read()
            .await
            .iter()
            .map(|m| {
                let qid = format!("codex.{}", m.id);
                BackendModelEntry {
                    id: qid.clone(),
                    name: m.name.clone(),
                    display_name: m.name.clone(),
                    gateway_id: to_gateway_model_id(&qid, true),
                    supports_images: m.supports_images,
                    description: format!("ChatGPT: {}", m.id).chars().take(100).collect(),
                    backend_key: "codex".to_string(),
                    backend_kind: BackendKind::Codex,
                    backend_label: "Codex".to_string(),
                    native_id: m.id.clone(),
                    qualified_id: qid,
                    brand: "openai".to_string(),
                    max_input_tokens: infer_max_input_tokens(&m.id),
                    max_tokens: 64_000,
                    supported_efforts: m.supported_efforts.clone(),
                    supported_speeds: m.supported_speeds.clone(),
                    is_free: true,
                }
            })
            .collect()
    }

    pub async fn get_status(&self) -> BackendHealthStatus {
        BackendHealthStatus {
            key: "codex".to_string(),
            kind: BackendKind::Codex,
            label: "Codex".to_string(),
            ready: self.is_ready().await,
            models_count: self.models.read().await.len(),
            active_sessions: self.active_session_count().await,
            error: self.last_error.read().await.clone(),
            executable: Some(self.executable.clone()),
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
        let cwd = req.cwd.clone().unwrap_or_else(|| settings.cwd.clone());
        let sys_hash = hash_system(&req.system);
        let fingerprints: Vec<String> = req
            .messages
            .iter()
            .map(|m| message_fingerprint(&m.role, &m.text, m.images.len()))
            .collect();

        let model_rec = self
            .models
            .read()
            .await
            .iter()
            .find(|m| m.id == native_model_id)
            .cloned()
            .unwrap_or_else(|| RawModelEntry {
                id: native_model_id.to_string(),
                name: native_model_id.to_string(),
                supports_images: true,
                description: None,
                supported_efforts: Vec::new(),
                effort_wire_values: HashMap::new(),
                default_effort: None,
                supported_speeds: Vec::new(),
            });

        let target_effort = resolve_thought_level(
            req.requested_effort,
            None,
            req.thinking_disabled,
            req.thinking_budget,
            settings.thought_level.or(model_rec.default_effort),
            &model_rec.supported_efforts,
        );
        let effort_wire = target_effort.map(|e| {
            model_rec
                .effort_wire_values
                .get(&e)
                .cloned()
                .unwrap_or_else(|| e.as_str().to_string())
        });
        let target_speed = resolve_speed(req.requested_speed, settings.speed, &model_rec.supported_speeds);

        let matched_tid = {
            let mut threads = self.threads.lock().await;
            let now = now_ms();
            let expired: Vec<String> = threads
                .iter()
                .filter(|(_, t)| !t.busy && now.saturating_sub(t.last_used_ms) > settings.idle_session_ttl_ms)
                .map(|(k, _)| k.clone())
                .collect();
            for k in expired {
                threads.remove(&k);
            }
            let mut best: Option<(String, usize)> = None;
            for (tid, t) in threads.iter() {
                if t.busy || t.cwd != cwd || t.system_hash != sys_hash {
                    continue;
                }
                let len = t.fingerprints.len();
                if len == 0 || len >= fingerprints.len() {
                    continue;
                }
                if t.fingerprints.iter().zip(fingerprints.iter()).all(|(a, b)| a == b) {
                    if best.as_ref().map(|(_, bl)| len > *bl).unwrap_or(true) {
                        best = Some((tid.clone(), len));
                    }
                }
            }
            best.map(|(id, _)| id)
        };

        let (mut thread, is_fresh) = if let Some(tid) = matched_tid {
            let mut threads = self.threads.lock().await;
            if let Some(t) = threads.get_mut(&tid) {
                t.busy = true;
                t.last_used_ms = now_ms();
                (t.clone(), false)
            } else {
                drop(threads);
                (self.start_thread(&model_rec.id, &cwd, &sys_hash, &req.system, &settings).await?, true)
            }
        } else {
            (self.start_thread(&model_rec.id, &cwd, &sys_hash, &req.system, &settings).await?, true)
        };

        let delta = if is_fresh {
            &req.messages[..]
        } else {
            &req.messages[thread.fingerprints.len()..]
        };

        let mut text_chunks = Vec::new();
        let mut images = Vec::new();
        if delta.len() == 1 && delta[0].role == "user" {
            if !delta[0].text.is_empty() {
                text_chunks.push(delta[0].text.clone());
            }
            images.extend(delta[0].images.clone());
        } else {
            for m in delta {
                let lbl = if m.role == "assistant" { "Assistant" } else { "User" };
                if !m.text.is_empty() {
                    text_chunks.push(format!("[{lbl}]\n{}", m.text));
                }
                images.extend(m.images.clone());
            }
        }
        if !images.is_empty() && !model_rec.supports_images {
            text_chunks.push(format!(
                "[{} image attachment(s) omitted because selected model does not support images]",
                images.len()
            ));
            images.clear();
        }
        let mut input = Vec::new();
        let combined = text_chunks.join("\n\n").trim().to_string();
        if !combined.is_empty() || images.is_empty() {
            let t = if combined.is_empty() { "Continue." } else { &combined };
            input.push(json!({ "type": "text", "text": t, "text_elements": [] }));
        }
        for img in images {
            input.push(json!({ "type": "image", "url": format!("data:{};base64,{}", img.mime_type, img.data) }));
        }

        let (done_tx, done_rx) = oneshot::channel();
        self.active_turns.lock().await.insert(
            thread.thread_id.clone(),
            TurnState {
                turn_id: None,
                assistant_text: String::new(),
                thinking_text: String::new(),
                commentary_items: HashSet::new(),
                seen_tools: HashMap::new(),
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                measured: false,
                sink,
                done_tx: Some(done_tx),
            },
        );

        let mut turn_params = json!({
            "threadId": thread.thread_id,
            "input": input,
            "cwd": cwd,
            "model": model_rec.id,
            "summary": "auto"
        });
        if let Some(ew) = effort_wire {
            turn_params["effort"] = json!(ew);
        }
        if let Some(spd) = target_speed {
            if spd != SpeedMode::Standard {
                turn_params["serviceTierForTurn"] = json!(spd.as_str());
            }
        }

        self.last_msg_ms.store(now_ms(), Ordering::SeqCst);
        let start_fut = self.rpc_request("turn/start", turn_params, settings.startup_timeout_ms);
        tokio::pin!(start_fut);
        let start_res = if let Some(notify) = &cancel_notify {
            tokio::select! {
                res = &mut start_fut => res,
                _ = notify.cancelled() => {
                    self.interrupt_active_turn(&thread.thread_id).await;
                    self.active_turns.lock().await.remove(&thread.thread_id);
                    self.threads.lock().await.remove(&thread.thread_id);
                    return Err("Запрос отменён пользователем".to_string());
                }
            }
        } else {
            start_fut.await
        };

        if let Err(e) = start_res {
            self.active_turns.lock().await.remove(&thread.thread_id);
            self.threads.lock().await.remove(&thread.thread_id);
            return Err(e);
        }

        if let Ok(sr) = start_res {
            if let Some(tid) = sr.get("turn").and_then(|t| t.get("id")).and_then(|v| v.as_str()) {
                if let Some(a) = self.active_turns.lock().await.get_mut(&thread.thread_id) {
                    if a.turn_id.is_none() {
                        a.turn_id = Some(tid.to_string());
                    }
                }
            }
        }

        let wait_fut = {
            let last = self.last_msg_ms.clone();
            let tools = self.tools_in_flight.clone();
            let idle_ms = settings.request_timeout_ms;
            let mut done_rx = done_rx;
            async move {
                loop {
                    match tokio::time::timeout(std::time::Duration::from_millis(1_000), &mut done_rx).await {
                        Ok(Ok(r)) => return r,
                        Ok(Err(_)) => return Err("Codex turn channel closed".to_string()),
                        Err(_) => {
                            let busy = tools.load(Ordering::SeqCst);
                            let limit = if busy > 0 { idle_ms.max(TOOL_IDLE_FLOOR_MS) } else { idle_ms };
                            let silent = now_ms().saturating_sub(last.load(Ordering::SeqCst));
                            if silent >= limit {
                                let hint = if busy > 0 {
                                    format!(", инструмент так и не завершился за {} мин", limit / 60_000)
                                } else {
                                    String::new()
                                };
                                return Err(format!(
                                    "Codex молчит {} с{hint}: похоже, зависло — попробуйте ещё раз",
                                    silent / 1000
                                ));
                            }
                        }
                    }
                }
            }
        };

        let outcome = if let Some(notify) = cancel_notify {
            tokio::select! {
                res = wait_fut => res,
                _ = notify.cancelled() => {
                    self.interrupt_active_turn(&thread.thread_id).await;
                    Err("Запрос отменён пользователем".to_string())
                }
            }
        } else {
            wait_fut.await
        };

        let turn_state = self.active_turns.lock().await.remove(&thread.thread_id);
        self.running_tools.lock().await.clear();
        self.tools_in_flight.store(0, Ordering::SeqCst);
        match outcome {
            Ok(()) => {
                let st = turn_state.unwrap();
                let mut new_fps = fingerprints;
                new_fps.push(message_fingerprint("assistant", &st.assistant_text, 0));
                thread.fingerprints = new_fps;
                thread.busy = false;
                thread.last_used_ms = now_ms();
                self.threads.lock().await.insert(thread.thread_id.clone(), thread);

                let thinking_tokens = crate::pricing::estimate_tokens_from_chars(st.thinking_text.len());
                Ok(TurnResult {
                    model_id: model_rec.id,
                    stop_reason: "end_turn".to_string(),
                    usage: TurnUsage {
                        input_tokens: st.input_tokens,
                        output_tokens: st.output_tokens,
                        cache_read_tokens: st.cache_read_tokens,
                        thinking_tokens,
                        measured: st.measured,
                    },
                    assistant_text: st.assistant_text,
                    thinking_text: st.thinking_text,
                })
            }
            Err(e) => {
                self.threads.lock().await.remove(&thread.thread_id);
                Err(e)
            }
        }
    }

    async fn start_thread(
        &self,
        model_id: &str,
        cwd: &str,
        sys_hash: &str,
        system_text: &str,
        settings: &AppSettings,
    ) -> Result<ThreadRecord, String> {
        let (sandbox, approval) = map_codex_sandbox(settings.mode);
        let mut params = json!({
            "model": model_id,
            "cwd": cwd,
            "approvalPolicy": approval,
            "sandbox": sandbox,
            "ephemeral": false
        });
        if !system_text.trim().is_empty() {
            params["developerInstructions"] = json!(system_text.trim());
        }
        let started = self
            .rpc_request("thread/start", params, settings.startup_timeout_ms)
            .await?;
        let tid = started
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .ok_or("Codex thread/start missing thread.id")?
            .to_string();
        let rec = ThreadRecord {
            thread_id: tid.clone(),
            cwd: cwd.to_string(),
            system_hash: sys_hash.to_string(),
            fingerprints: Vec::new(),
            busy: true,
            last_used_ms: now_ms(),
        };
        self.threads.lock().await.insert(tid, rec.clone());
        Ok(rec)
    }

    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.threads.lock().await.clear();
        let mut st = self.proc_state.lock().await;
        st.stdin = None;
        st.initialized = false;
        if let Some(mut c) = st.child.take() {
            let _ = c.kill().await;
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NormalizedMessage;
    use tokio::io::DuplexStream;
    use tokio::sync::mpsc;

    struct FakeCodexServer {
        task: tokio::task::JoinHandle<()>,
        turn_starts: mpsc::UnboundedReceiver<()>,
        interrupts: mpsc::UnboundedReceiver<Value>,
    }

    fn test_backend() -> Arc<CodexBackend> {
        let settings = Arc::new(RwLock::new(AppSettings::default()));
        let log: LogFn = Arc::new(|_, _, _| {});
        CodexBackend::new("fake-codex".into(), settings, log)
    }

    async fn prepare_backend() -> (Arc<CodexBackend>, DuplexStream) {
        let backend = test_backend();
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

        let (backend_write, server_read) = tokio::io::duplex(8192);
        {
            let mut st = backend.proc_state.lock().await;
            st.stdin = Some(Box::new(backend_write));
            st.initialized = true;
        }
        (backend, server_read)
    }

    fn spawn_fake_server(
        backend: Arc<CodexBackend>,
        server_read: DuplexStream,
        delay_turn_start_response: bool,
    ) -> FakeCodexServer {
        let (turn_start_tx, turn_starts) = mpsc::unbounded_channel::<()>();
        let (interrupt_tx, interrupts) = mpsc::unbounded_channel::<Value>();
        let server_backend = backend.clone();
        let task = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                let id = msg.get("id").cloned();
                match method {
                    "thread/start" => {
                        if let Some(id) = id {
                            server_backend
                                .handle_incoming(json!({
                                    "id": id,
                                    "result": { "thread": { "id": "thread-1" } }
                                }))
                                .await;
                        }
                    }
                    "turn/start" => {
                        let _ = turn_start_tx.send(());
                        let thread_id = msg
                            .get("params")
                            .and_then(|p| p.get("threadId"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("thread-1")
                            .to_string();
                        server_backend
                            .handle_incoming(json!({
                                "method": "turn/started",
                                "params": {
                                    "threadId": thread_id,
                                    "turn": { "id": "turn-1" }
                                }
                            }))
                            .await;
                        if !delay_turn_start_response {
                            if let Some(id) = id {
                                server_backend
                                    .handle_incoming(json!({
                                        "id": id,
                                        "result": { "turn": { "id": "turn-1" } }
                                    }))
                                    .await;
                            }
                            server_backend
                                .handle_incoming(json!({
                                    "method": "item/agentMessage/delta",
                                    "params": {
                                        "threadId": thread_id,
                                        "itemId": "message-1",
                                        "delta": "working"
                                    }
                                }))
                                .await;
                        }
                    }
                    "turn/interrupt" => {
                        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                        let _ = interrupt_tx.send(params);
                        if let Some(id) = id {
                            server_backend
                                .handle_incoming(json!({ "id": id, "result": {} }))
                                .await;
                        }
                    }
                    _ => {
                        if let Some(id) = id {
                            server_backend
                                .handle_incoming(json!({ "id": id, "result": {} }))
                                .await;
                        }
                    }
                }
            }
        });
        FakeCodexServer {
            task,
            turn_starts,
            interrupts,
        }
    }

    fn spawn_turn(
        backend: Arc<CodexBackend>,
        cancel: Arc<CancelToken>,
        sink: Option<StreamSink>,
    ) -> tokio::task::JoinHandle<Result<TurnResult, String>> {
        tokio::spawn(async move {
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
            backend.run_turn("fake-model", &req, sink, Some(cancel)).await
        })
    }

    async fn expect_interrupt(server: &mut FakeCodexServer) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(2), server.interrupts.recv())
            .await
            .expect("turn/interrupt was not sent")
            .expect("interrupt channel closed")
    }

    async fn expect_cancelled_turn(
        turn_task: tokio::task::JoinHandle<Result<TurnResult, String>>,
    ) {
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), turn_task)
            .await
            .expect("cancelled Codex turn did not finish")
            .expect("turn task panicked");
        assert!(outcome.is_err(), "cancelled turn unexpectedly succeeded");
    }

    #[tokio::test]
    async fn cancel_token_sends_turn_interrupt_for_active_turn() {
        let (backend, server_read) = prepare_backend().await;
        let mut server = spawn_fake_server(backend.clone(), server_read, false);

        let (sink, mut stream_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancelToken::new();
        let turn_task = spawn_turn(backend.clone(), cancel.clone(), Some(sink));

        let first_event = tokio::time::timeout(std::time::Duration::from_secs(2), stream_rx.recv())
            .await
            .expect("fake Codex did not start streaming")
            .expect("stream closed before the first chunk");
        assert!(matches!(first_event, StreamEvent::Text(ref chunk) if chunk == "working"));

        cancel.cancel();
        let interrupt_params = expect_interrupt(&mut server).await;
        assert_eq!(interrupt_params["threadId"], "thread-1");
        assert_eq!(interrupt_params["turnId"], "turn-1");
        expect_cancelled_turn(turn_task).await;

        backend.shutdown().await;
        server.task.abort();
    }

    #[tokio::test]
    async fn cancel_token_interrupts_turn_while_start_response_is_pending() {
        let (backend, server_read) = prepare_backend().await;
        let mut server = spawn_fake_server(backend.clone(), server_read, true);

        let cancel = CancelToken::new();
        let turn_task = spawn_turn(backend.clone(), cancel.clone(), None);
        tokio::time::timeout(std::time::Duration::from_secs(2), server.turn_starts.recv())
            .await
            .expect("fake Codex did not receive turn/start")
            .expect("turn/start channel closed");

        cancel.cancel();
        let interrupt_params = expect_interrupt(&mut server).await;
        assert_eq!(interrupt_params["threadId"], "thread-1");
        assert_eq!(interrupt_params["turnId"], "turn-1");
        expect_cancelled_turn(turn_task).await;

        backend.shutdown().await;
        server.task.abort();
    }
}
