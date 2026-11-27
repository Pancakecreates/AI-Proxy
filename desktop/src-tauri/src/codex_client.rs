use crate::acp_client::{hash_system, message_fingerprint, LogFn, StreamEvent, StreamSink};
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Notify, RwLock};

struct CodexInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
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
}

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
            st.stdin = Some(stdin);
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

    async fn handle_notification(&self, method: &str, params: &Value) {
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
                    active.input_tokens = inp;
                    active.output_tokens = out;
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
        cancel_notify: Option<Arc<Notify>>,
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

        let start_res = self
            .rpc_request("turn/start", turn_params, settings.startup_timeout_ms)
            .await;

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

        let wait_fut = tokio::time::timeout(
            std::time::Duration::from_millis(settings.request_timeout_ms),
            done_rx,
        );

        let outcome = if let Some(notify) = cancel_notify {
            tokio::select! {
                res = wait_fut => match res {
                    Ok(Ok(r)) => r,
                    Ok(Err(_)) => Err("Codex turn channel closed".to_string()),
                    Err(_) => Err("Codex turn timeout".to_string()),
                },
                _ = notify.notified() => {
                    let turn_id = self.active_turns.lock().await.get(&thread.thread_id).and_then(|a| a.turn_id.clone());
                    if let Some(tid) = turn_id {
                        let _ = self.rpc_request("turn/interrupt", json!({ "threadId": thread.thread_id, "turnId": tid }), 5_000).await;
                    }
                    Err("Запрос отменён пользователем".to_string())
                }
            }
        } else {
            match wait_fut.await {
                Ok(Ok(r)) => r,
                Ok(Err(_)) => Err("Codex turn channel closed".to_string()),
                Err(_) => Err("Codex turn timeout".to_string()),
            }
        };

        let turn_state = self.active_turns.lock().await.remove(&thread.thread_id);
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

