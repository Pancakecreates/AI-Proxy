use crate::acp_client::{LogFn, StreamEvent, StreamSink};
use crate::cancel::CancelToken;
use crate::models::{infer_max_input_tokens, infer_model_brand, to_gateway_model_id};
use crate::net::{build_client, effective_proxy_for, normalize_base_url};
use crate::types::{
    AppSettings, BackendHealthStatus, BackendKind, BackendModelEntry, ExternalProviderConfig,
    NormalizedMessage, TurnResult, TurnUsage, UnifiedTurnRequest,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

/// Бэкенд стороннего OpenAI-совместимого API: список моделей с /models,
/// генерация через /chat/completions в потоковом режиме.
pub struct ExternalBackend {
    pub key: String,
    pub cfg: ExternalProviderConfig,
    settings: Arc<RwLock<AppSettings>>,
    log: LogFn,
    models: Arc<RwLock<Vec<BackendModelEntry>>>,
    last_error: Arc<RwLock<Option<String>>>,
    warmup_lock: Arc<Mutex<()>>,
    in_flight: Arc<AtomicUsize>,
}

impl ExternalBackend {
    pub fn new(
        cfg: ExternalProviderConfig,
        settings: Arc<RwLock<AppSettings>>,
        log: LogFn,
    ) -> Arc<Self> {
        let key = format!("ext:{}", cfg.id);
        Arc::new(Self {
            key,
            cfg,
            settings,
            log,
            models: Arc::new(RwLock::new(Vec::new())),
            last_error: Arc::new(RwLock::new(None)),
            warmup_lock: Arc::new(Mutex::new(())),
            in_flight: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn base_url(&self) -> Result<String, String> {
        normalize_base_url(&self.cfg.base_url)
    }

    async fn client(&self) -> Result<reqwest::Client, String> {
        let global = self.settings.read().await.proxy_url.clone();
        let proxy = effective_proxy_for(&self.cfg, global.as_deref()).map(|s| s.to_string());
        build_client(proxy.as_deref(), None)
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut out = req;
        if let Some(key) = self.cfg.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            out = out.header("Authorization", format!("Bearer {key}"));
        }
        for (k, v) in &self.cfg.extra_headers {
            if !k.trim().is_empty() {
                out = out.header(k.trim(), v.trim());
            }
        }
        out
    }

    pub async fn warm_up(&self, force: bool) -> Result<Vec<BackendModelEntry>, String> {
        if !force && !self.models.read().await.is_empty() {
            return Ok(self.models.read().await.clone());
        }
        let _lock = self.warmup_lock.lock().await;
        if !force && !self.models.read().await.is_empty() {
            return Ok(self.models.read().await.clone());
        }

        let base = self.base_url()?;
        let client = self.client().await?;
        let url = format!("{base}/models");
        let resp = self
            .apply_auth(client.get(&url))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("{e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let detail = extract_api_error(&body)
                .unwrap_or_else(|| body.chars().take(200).collect::<String>());
            let msg = format!("HTTP {status} при запросе списка моделей: {detail}");
            *self.last_error.write().await = Some(msg.clone());
            return Err(msg);
        }
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| format!("Некорректный JSON списка моделей: {e}"))?;
        let data = payload
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if data.is_empty() {
            let msg = "Провайдер вернул пустой список моделей".to_string();
            *self.last_error.write().await = Some(msg.clone());
            return Err(msg);
        }

        let entries: Vec<BackendModelEntry> = data
            .iter()
            .filter_map(|item| {
                let id = item.get("id").and_then(|v| v.as_str())?.trim().to_string();
                if id.is_empty() {
                    return None;
                }
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(&id)
                    .to_string();
                let ctx = item
                    .get("context_length")
                    .or_else(|| item.get("context_window"))
                    .or_else(|| item.get("max_input_tokens"))
                    .or_else(|| item.get("top_provider").and_then(|tp| tp.get("context_length")))
                    .and_then(|v| v.as_u64())
                    .unwrap_or_else(|| infer_max_input_tokens(&id));
                let gateway = to_gateway_model_id(&id, false);
                Some(BackendModelEntry {
                    id: id.clone(),
                    name: name.clone(),
                    display_name: name.clone(),
                    gateway_id: format!("{}-{}", self.cfg.id, gateway),
                    supports_images: true,
                    description: self.cfg.display_name.clone(),
                    backend_key: self.key.clone(),
                    backend_kind: BackendKind::External,
                    backend_label: self.cfg.display_name.clone(),
                    native_id: id.clone(),
                    qualified_id: format!("{}/{id}", self.key),
                    brand: infer_model_brand(&id, BackendKind::External).to_string(),
                    max_input_tokens: ctx,
                    max_tokens: 8192,
                    supported_efforts: Vec::new(),
                    supported_speeds: Vec::new(),
                    is_free: false,
                })
            })
            .collect();

        if entries.is_empty() {
            let msg = "Не удалось распознать ни одной модели в ответе провайдера".to_string();
            *self.last_error.write().await = Some(msg.clone());
            return Err(msg);
        }

        *self.last_error.write().await = None;
        let count = entries.len();
        *self.models.write().await = entries.clone();
        (self.log)(
            "info",
            &self.key,
            &format!("Каталог {}: {} моделей", self.cfg.display_name, count),
        );
        Ok(entries)
    }

    pub async fn list_models(&self) -> Vec<BackendModelEntry> {
        self.models.read().await.clone()
    }

    pub async fn get_status(&self) -> BackendHealthStatus {
        let models = self.models.read().await.len();
        let err = self.last_error.read().await.clone();
        BackendHealthStatus {
            key: self.key.clone(),
            kind: BackendKind::External,
            label: self.cfg.display_name.clone(),
            ready: err.is_none() && models > 0,
            models_count: models,
            active_sessions: self.in_flight.load(Ordering::Relaxed),
            error: err,
            executable: self.base_url().ok(),
        }
    }

    pub async fn run_turn(
        &self,
        native_model_id: &str,
        req: &UnifiedTurnRequest,
        sink: Option<StreamSink>,
        cancel: Option<Arc<CancelToken>>,
    ) -> Result<TurnResult, String> {
        let base = self.base_url()?;
        let client = self.client().await?;

        let mut messages: Vec<Value> = Vec::new();
        if !req.system.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": req.system }));
        }
        for m in &req.messages {
            messages.push(openai_message(m));
        }

        let mut body = json!({
            "model": native_model_id,
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true },
            "max_tokens": self.cfg.max_output_tokens.filter(|v| *v > 0).unwrap_or(16384),
        });
        if !req.thinking_disabled {
            if let Some(effort) = req.requested_effort {
                let mapped = match effort {
                    crate::types::ThoughtLevel::Minimal => Some("minimal"),
                    crate::types::ThoughtLevel::Low => Some("low"),
                    crate::types::ThoughtLevel::Medium => Some("medium"),
                    crate::types::ThoughtLevel::High
                    | crate::types::ThoughtLevel::Xhigh
                    | crate::types::ThoughtLevel::Max => Some("high"),
                    crate::types::ThoughtLevel::None => None,
                };
                if let Some(val) = mapped {
                    body["reasoning_effort"] = json!(val);
                }
            }
        }

        self.in_flight.fetch_add(1, Ordering::Relaxed);
        let result = self
            .stream_completion(&client, &base, &body, native_model_id, sink, cancel)
            .await;
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
        result
    }

    async fn stream_completion(
        &self,
        client: &reqwest::Client,
        base: &str,
        body: &Value,
        native_model_id: &str,
        sink: Option<StreamSink>,
        cancel: Option<Arc<CancelToken>>,
    ) -> Result<TurnResult, String> {
        let url = format!("{base}/chat/completions");
        if cancel.as_ref().map(|c| c.is_cancelled()).unwrap_or(false) {
            return Err("Запрос отменён".to_string());
        }
        let send_fut = self.apply_auth(client.post(&url).json(body)).send();
        let resp = if let Some(c) = &cancel {
            tokio::select! {
                _ = c.cancelled() => return Err("Запрос отменён".to_string()),
                r = send_fut => r,
            }
        } else {
            send_fut.await
        }
        .map_err(|e| format!("{e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let detail =
                extract_api_error(&text).unwrap_or_else(|| text.chars().take(240).collect());
            return Err(format!("HTTP {status}: {detail}"));
        }

        let idle_ms = self.settings.read().await.request_timeout_ms.max(60_000);
        let idle = Duration::from_millis(idle_ms);

        let mut byte_stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut assistant = String::new();
        let mut thinking = String::new();
        let mut finish_reason = String::new();
        let mut usage_in: u64 = 0;
        let mut usage_out: u64 = 0;
        let mut cache_read: u64 = 0;
        let mut reasoning_tokens: u64 = 0;
        let mut usage_seen = false;

        loop {
            let timed = tokio::time::timeout(idle, byte_stream.next());
            let item = if let Some(c) = &cancel {
                tokio::select! {
                    _ = c.cancelled() => return Err("Запрос отменён".to_string()),
                    r = timed => r,
                }
            } else {
                timed.await
            };

            let chunk = match item {
                Err(_) => {
                    return Err(format!(
                        "Провайдер не присылал данные {} сек — соединение сброшено по таймауту",
                        idle_ms / 1000
                    ))
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => return Err(format!("Ошибка чтения потока: {e}")),
                Ok(Some(Ok(bytes))) => bytes,
            };

            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes);
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    continue;
                }
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload == "[DONE]" {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(payload) else {
                    continue;
                };
                process_event(
                    &event,
                    &mut assistant,
                    &mut thinking,
                    &mut finish_reason,
                    &mut usage_in,
                    &mut usage_out,
                    &mut cache_read,
                    &mut reasoning_tokens,
                    &mut usage_seen,
                    &sink,
                );
            }
        }

        if assistant.is_empty() && thinking.is_empty() {
            return Err("Провайдер завершил поток без единого фрагмента ответа".to_string());
        }

        if let Some(s) = &sink {
            let _ = s.send(StreamEvent::Usage {
                input_tokens: usage_in,
                output_tokens: usage_out,
            });
        }

        let stop_reason = match finish_reason.as_str() {
            "stop" | "end_turn" | "" => "end_turn",
            "length" | "max_tokens" => "max_tokens",
            other => other,
        };

        Ok(TurnResult {
            model_id: native_model_id.to_string(),
            stop_reason: stop_reason.to_string(),
            usage: TurnUsage {
                input_tokens: usage_in,
                output_tokens: usage_out,
                cache_read_tokens: cache_read,
                thinking_tokens: reasoning_tokens,
                measured: usage_seen,
            },
            assistant_text: assistant,
            thinking_text: thinking,
        })
    }

    pub async fn shutdown(&self) {}
}

#[allow(clippy::too_many_arguments)]
fn process_event(
    event: &Value,
    assistant: &mut String,
    thinking: &mut String,
    finish_reason: &mut String,
    usage_in: &mut u64,
    usage_out: &mut u64,
    cache_read: &mut u64,
    reasoning_tokens: &mut u64,
    usage_seen: &mut bool,
    sink: &Option<StreamSink>,
) {
    if let Some(usage) = event.get("usage") {
        if let Some(v) = usage.get("prompt_tokens").and_then(|x| x.as_u64()) {
            *usage_in = v;
            *usage_seen = true;
        }
        if let Some(v) = usage.get("completion_tokens").and_then(|x| x.as_u64()) {
            *usage_out = v;
            *usage_seen = true;
        }
        if let Some(v) = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|x| x.as_u64())
        {
            *cache_read = v;
        }
        if let Some(v) = usage
            .get("completion_tokens_details")
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(|x| x.as_u64())
        {
            *reasoning_tokens = v;
        }
    }

    let choices = match event.get("choices").and_then(|c| c.as_array()) {
        Some(c) if !c.is_empty() => c,
        _ => return,
    };
    let first = &choices[0];

    if let Some(fr) = first.get("finish_reason").and_then(|v| v.as_str()) {
        if finish_reason.is_empty() {
            *finish_reason = fr.to_string();
        }
    }

    let Some(delta) = first.get("delta") else {
        return;
    };

    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = delta.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                thinking.push_str(text);
                if let Some(s) = sink {
                    let _ = s.send(StreamEvent::Thinking(text.to_string()));
                }
            }
        }
    }

    if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
        if !text.is_empty() {
            assistant.push_str(text);
            if let Some(s) = sink {
                let _ = s.send(StreamEvent::Text(text.to_string()));
            }
        }
    }
}

fn openai_message(m: &NormalizedMessage) -> Value {
    let role = if m.role == "assistant" { "assistant" } else { "user" };
    if m.images.is_empty() {
        return json!({ "role": role, "content": m.text });
    }
    let mut parts: Vec<Value> = Vec::new();
    if !m.text.is_empty() {
        parts.push(json!({ "type": "text", "text": m.text }));
    }
    for img in &m.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.mime_type, img.data) },
        }));
    }
    if parts.is_empty() {
        parts.push(json!({ "type": "text", "text": "" }));
    }
    json!({ "role": role, "content": parts })
}

fn extract_api_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let take = |s: &str| s.chars().take(240).collect::<String>();
    v.get("error")
        .and_then(|e| {
            e.get("message")
                .and_then(|m| m.as_str())
                .or_else(|| e.as_str())
        })
        .map(take)
        .or_else(|| v.get("message").and_then(|m| m.as_str()).map(take))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AppSettings, UnifiedTurnRequest};

    #[test]
    fn parses_openai_delta_event() {
        let event = json!({
            "choices": [{ "delta": { "content": "Привет" }, "finish_reason": null }]
        });
        let mut assistant = String::new();
        let mut thinking = String::new();
        let mut finish = String::new();
        let (mut ui, mut uo, mut cr, mut rt) = (0, 0, 0, 0);
        let mut seen = false;
        process_event(
            &event, &mut assistant, &mut thinking, &mut finish,
            &mut ui, &mut uo, &mut cr, &mut rt, &mut seen, &None,
        );
        assert_eq!(assistant, "Привет");
        assert!(thinking.is_empty());
        assert!(!seen);
    }

    #[test]
    fn parses_reasoning_and_usage_event() {
        let event = json!({
            "choices": [{ "delta": { "reasoning_content": "думаю" }, "finish_reason": "stop" }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "prompt_tokens_details": { "cached_tokens": 3 },
                "completion_tokens_details": { "reasoning_tokens": 2 }
            }
        });
        let mut assistant = String::new();
        let mut thinking = String::new();
        let mut finish = String::new();
        let (mut ui, mut uo, mut cr, mut rt) = (0, 0, 0, 0);
        let mut seen = false;
        process_event(
            &event, &mut assistant, &mut thinking, &mut finish,
            &mut ui, &mut uo, &mut cr, &mut rt, &mut seen, &None,
        );
        assert_eq!(thinking, "думаю");
        assert_eq!(finish, "stop");
        assert_eq!(ui, 10);
        assert_eq!(uo, 5);
        assert_eq!(cr, 3);
        assert_eq!(rt, 2);
        assert!(seen);
    }

    async fn spawn_mock_openai() -> String {
        use axum::{routing::{get, post}, Json, Router};

        async fn models() -> Json<Value> {
            Json(json!({
                "data": [
                    { "id": "mock-model-1", "context_length": 128000 },
                    { "id": "vendor/mock-model-2" }
                ]
            }))
        }

        async fn completions() -> impl axum::response::IntoResponse {
            let events = [
                json!({"choices":[{"delta":{"reasoning_content":"раз"}}]}),
                json!({"choices":[{"delta":{"reasoning_content":"мышь"}}]}),
                json!({"choices":[{"delta":{"content":"При"}}]}),
                json!({"choices":[{"delta":{"content":"вет"},"finish_reason":"stop"}]}),
                json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}),
            ];
            let mut body = String::new();
            for e in events {
                body.push_str(&format!("data: {}

", e));
            }
            body.push_str("data: [DONE]

");
            (
                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                body,
            )
        }

        let app = Router::new()
            .route("/v1/models", get(models))
            .route("/v1/chat/completions", post(completions));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    fn test_backend(base_url: &str) -> Arc<ExternalBackend> {
        let settings = Arc::new(RwLock::new(AppSettings::default()));
        let log: LogFn = Arc::new(|_, _, _| {});
        ExternalBackend::new(
            ExternalProviderConfig {
                id: "mock".into(),
                display_name: "Mock".into(),
                base_url: base_url.into(),
                api_key: Some("test-key".into()),
                enabled: true,
                proxy_mode: crate::types::ProxyMode::Disabled,
                proxy_url: None,
                extra_headers: Default::default(),
                max_output_tokens: None,
            },
            settings,
            log,
        )
    }

    #[tokio::test]
    async fn warm_up_lists_models_from_mock() {
        let base = spawn_mock_openai().await;
        let backend = test_backend(&base);
        let models = backend.warm_up(true).await.expect("warm up");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].native_id, "mock-model-1");
        assert_eq!(models[0].max_input_tokens, 128000);
        assert!(models.iter().any(|m| m.native_id == "vendor/mock-model-2"));
        assert!(backend.get_status().await.ready);
    }

    #[tokio::test]
    async fn run_turn_streams_sse_end_to_end() {
        let base = spawn_mock_openai().await;
        let backend = test_backend(&base);
        backend.warm_up(true).await.expect("warm up");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let req = UnifiedTurnRequest {
            model: Some("mock-model-1".into()),
            system: "sys".into(),
            messages: vec![NormalizedMessage {
                role: "user".into(),
                text: "hi".into(),
                images: vec![],
            }],
            requested_effort: None,
            thinking_disabled: false,
            thinking_budget: None,
            requested_speed: None,
            cwd: None,
        };
        let turn = backend
            .run_turn("mock-model-1", &req, Some(tx), None)
            .await
            .expect("run turn");
        assert_eq!(turn.assistant_text, "Привет");
        assert_eq!(turn.thinking_text, "размышь");
        assert_eq!(turn.stop_reason, "end_turn");
        assert_eq!(turn.usage.input_tokens, 12);
        assert_eq!(turn.usage.output_tokens, 4);
        assert!(turn.usage.measured);

        let mut streamed = String::new();
        while let Ok(ev) = rx.try_recv() {
            if let StreamEvent::Text(t) = ev {
                streamed.push_str(&t);
            }
        }
        assert_eq!(streamed, "Привет");
    }

    #[test]
    fn extracts_error_message() {
        let body = r#"{"error":{"message":"Invalid API key","type":"auth"}}"#;
        assert_eq!(extract_api_error(body).as_deref(), Some("Invalid API key"));
        assert!(extract_api_error("not json").is_none());
    }
}
