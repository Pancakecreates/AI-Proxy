use crate::acp_client::StreamEvent;
use crate::db::AppDb;
use crate::models::{
    format_anthropic_models_list, format_openai_models_list, normalize_effort_value,
};
use crate::pricing::{calculate_costs, estimate_tokens_from_chars};
use crate::router::{BackendRouter, RunTurnError};
use crate::types::{
    AppSettings, ImageAttachment, NormalizedMessage, RequestLogEntry, UnifiedTurnRequest,
};
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, RwLock};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
pub struct HttpSharedState {
    pub router: Arc<BackendRouter>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub db: Arc<AppDb>,
    pub on_request_log: Option<Arc<dyn Fn(&RequestLogEntry) + Send + Sync>>,
    pub force_openai: bool,
}

#[derive(Deserialize)]
pub struct ModelsQuery {
    pub refresh: Option<String>,
    pub raw: Option<String>,
    pub format: Option<String>,
}

fn check_auth(headers: &HeaderMap, expected: &Option<String>) -> bool {
    let Some(exp) = expected.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return true;
    };
    if let Some(v) = headers.get("x-api-key").and_then(|x| x.to_str().ok()) {
        if v.trim() == exp {
            return true;
        }
    }
    if let Some(auth) = headers.get("authorization").and_then(|x| x.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")) {
            if token.trim() == exp {
                return true;
            }
        }
    }
    false
}

fn anthropic_error(status: StatusCode, err_type: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "type": "error",
            "error": { "type": err_type, "message": message }
        })),
    )
        .into_response()
}

fn openai_error(status: StatusCode, err_type: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "type": err_type,
                "param": null,
                "code": null
            }
        })),
    )
        .into_response()
}

fn record_turn_error(
    state: &HttpSharedState,
    request_id: String,
    protocol: &str,
    path: String,
    model: String,
    latency_ms: u64,
    est_in_chars: usize,
    prompt_preview: Option<String>,
    err: &RunTurnError,
) {
    record_request_log(
        state,
        RequestLogEntry {
            id: 0,
            created_at: Utc::now().to_rfc3339(),
            request_id,
            protocol: protocol.into(),
            method: "POST".into(),
            path,
            model,
            resolved_model: err.resolved_model.clone(),
            effort: err.effort.clone(),
            backend_key: err.backend_key.clone(),
            account_label: err.backend_label.clone(),
            status: 502,
            latency_ms,
            input_tokens: estimate_tokens_from_chars(est_in_chars),
            output_tokens: 0,
            cache_read_tokens: 0,
            thinking_tokens: 0,
            usage_source: "estimated".into(),
            cost_usd: 0.0,
            api_equivalent_usd: 0.0,
            error: Some(err.message.clone()),
            prompt_preview,
            response_preview: None,
        },
    );
}

fn extract_anthropic_system(val: Option<&Value>) -> String {
    let Some(v) = val else { return String::new() };
    if let Some(s) = v.as_str() {
        return s.trim().to_string();
    }
    let Some(arr) = v.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            parts.push(s.to_string());
        } else if item.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                parts.push(t.to_string());
            }
        }
    }
    parts.join("\n\n").trim().to_string()
}

fn normalize_anthropic_content(val: Option<&Value>) -> (String, Vec<ImageAttachment>) {
    let Some(v) = val else {
        return (String::new(), Vec::new());
    };
    if let Some(s) = v.as_str() {
        return (s.to_string(), Vec::new());
    }
    let Some(arr) = v.as_array() else {
        return (String::new(), Vec::new());
    };
    let mut text_parts = Vec::new();
    let mut images = Vec::new();
    for block in arr {
        let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "text" => {
                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                    text_parts.push(t.to_string());
                }
            }
            "image" => {
                if let Some(src) = block.get("source") {
                    if src.get("type").and_then(|t| t.as_str()) == Some("base64") {
                        if let Some(data) = src.get("data").and_then(|d| d.as_str()) {
                            let mime = src
                                .get("media_type")
                                .and_then(|m| m.as_str())
                                .unwrap_or("image/png");
                            images.push(ImageAttachment {
                                data: data.to_string(),
                                mime_type: mime.to_string(),
                            });
                        }
                    }
                }
            }
            "tool_use" => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let inp = block.get("input").cloned().unwrap_or(json!({}));
                text_parts.push(format!("[Tool Call: {name}]\n{inp}"));
            }
            "tool_result" => {
                let is_err = block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                let (nested_txt, nested_imgs) = normalize_anthropic_content(block.get("content"));
                let prefix = if is_err { "[Tool Error]" } else { "[Tool Result]" };
                text_parts.push(format!("{prefix}\n{nested_txt}"));
                images.extend(nested_imgs);
            }
            _ => {}
        }
    }
    (text_parts.join("\n\n").trim().to_string(), images)
}

fn normalize_openai_content(val: Option<&Value>) -> (String, Vec<ImageAttachment>) {
    let Some(v) = val else {
        return (String::new(), Vec::new());
    };
    if let Some(s) = v.as_str() {
        return (s.to_string(), Vec::new());
    }
    let Some(arr) = v.as_array() else {
        return (String::new(), Vec::new());
    };
    let mut text_parts = Vec::new();
    let mut images = Vec::new();
    for part in arr {
        let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "text" | "input_text" | "output_text" => {
                if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                    text_parts.push(t.to_string());
                }
            }
            "image_url" | "input_image" => {
                let url = part
                    .get("image_url")
                    .and_then(|u| u.get("url").or(Some(u)))
                    .or_else(|| part.get("image_url"))
                    .and_then(|u| u.as_str());
                if let Some(u) = url {
                    if let Some(rest) = u.strip_prefix("data:") {
                        if let Some((meta, b64)) = rest.split_once(";base64,") {
                            images.push(ImageAttachment {
                                data: b64.to_string(),
                                mime_type: meta.to_string(),
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }
    (text_parts.join("\n\n").trim().to_string(), images)
}

fn estimate_request_chars(req: &UnifiedTurnRequest) -> usize {
    let mut c = req.system.len();
    for m in &req.messages {
        c += m.text.len() + m.images.len() * 2800;
    }
    c
}

fn record_request_log(
    state: &HttpSharedState,
    entry: RequestLogEntry,
) {
    if let Ok(saved) = state.db.insert_request_log(&entry) {
        if let Some(cb) = &state.on_request_log {
            cb(&saved);
        }
    }
}

async fn health_handler(State(state): State<HttpSharedState>) -> Json<Value> {
    let backends = state.router.get_health_statuses().await;
    let models = state.router.list_models().await;
    let active_sessions = state.router.active_session_count().await;
    let s = state.settings.read().await;
    let devin_ready = backends
        .iter()
        .find(|b| b.kind == crate::types::BackendKind::Devin)
        .map(|b| b.ready)
        .unwrap_or_else(|| backends.iter().any(|b| b.ready));

    Json(json!({
        "ok": true,
        "devinReady": devin_ready,
        "modelsCount": models.len(),
        "activeSessions": active_sessions,
        "mode": s.mode.as_str(),
        "cwd": s.cwd,
        "backends": backends
    }))
}

async fn models_handler(
    State(state): State<HttpSharedState>,
    headers: HeaderMap,
    uri: Uri,
    Query(q): Query<ModelsQuery>,
) -> Response {
    let s = state.settings.read().await.clone();
    if !check_auth(&headers, &s.api_key) {
        return anthropic_error(StatusCode::UNAUTHORIZED, "authentication_error", "Invalid API key.");
    }

    let refresh = q.refresh.as_deref() == Some("1");
    let raw_ids = q.raw.as_deref() == Some("1");
    if refresh || state.router.list_models().await.is_empty() {
        state.router.warm_up(refresh).await;
    }
    let settings_snapshot = state.settings.read().await.clone();
    let models: Vec<_> = state
        .router
        .list_models()
        .await
        .into_iter()
        .filter(|m| !crate::router::is_model_disabled(&settings_snapshot, m))
        .collect();

    let path = uri.path();
    let is_openai = state.force_openai
        || q.format.as_deref() == Some("openai")
        || path.starts_with("/openai/");

    if is_openai {
        Json(format_openai_models_list(&models)).into_response()
    } else {
        Json(format_anthropic_models_list(&models, s.gateway_aliases && !raw_ids)).into_response()
    }
}

async fn count_tokens_handler(
    State(state): State<HttpSharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let s = state.settings.read().await.clone();
    if !check_auth(&headers, &s.api_key) {
        return anthropic_error(StatusCode::UNAUTHORIZED, "authentication_error", "Invalid API key.");
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let sys_len = extract_anthropic_system(parsed.get("system")).len();
    let mut msg_len = 0usize;
    if let Some(arr) = parsed.get("messages").and_then(|v| v.as_array()) {
        for m in arr {
            let (t, imgs) = normalize_anthropic_content(m.get("content"));
            msg_len += t.len() + imgs.len() * 2800;
        }
    }
    Json(json!({ "input_tokens": estimate_tokens_from_chars(sys_len + msg_len).max(1) })).into_response()
}

async fn anthropic_messages_handler(
    State(state): State<HttpSharedState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let req_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let s = state.settings.read().await.clone();
    if !check_auth(&headers, &s.api_key) {
        return anthropic_error(StatusCode::UNAUTHORIZED, "authentication_error", "Invalid API key.");
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return anthropic_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Invalid JSON body."),
    };

    let Some(msgs_arr) = parsed.get("messages").and_then(|v| v.as_array()) else {
        return anthropic_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Field 'messages' must be a non-empty array.");
    };
    if msgs_arr.is_empty() {
        return anthropic_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Field 'messages' must be a non-empty array.");
    }

    let requested_model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());

    let system = extract_anthropic_system(parsed.get("system"));
    let messages: Vec<NormalizedMessage> = msgs_arr
        .iter()
        .map(|m| {
            let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user").to_string();
            let (text, images) = normalize_anthropic_content(m.get("content"));
            NormalizedMessage { role, text, images }
        })
        .collect();

    let prompt_preview = messages
        .last()
        .map(|m| m.text.chars().take(180).collect::<String>());

    let thinking_obj = parsed.get("thinking");
    let thinking_type = thinking_obj.and_then(|t| t.get("type")).and_then(|v| v.as_str());
    let thinking_disabled = thinking_type == Some("disabled");
    let thinking_budget = if thinking_type == Some("enabled") {
        thinking_obj.and_then(|t| t.get("budget_tokens")).and_then(|v| v.as_u64())
    } else {
        None
    };

    let output_effort = parsed
        .get("output_config")
        .and_then(|o| o.get("effort"))
        .and_then(|v| v.as_str());
    let requested_effort = normalize_effort_value(output_effort);

    let cwd_hdr = headers
        .get("x-devin-cwd")
        .or_else(|| headers.get("x-cwd"))
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let unified = UnifiedTurnRequest {
        model: requested_model.clone(),
        system,
        messages,
        requested_effort,
        thinking_disabled,
        thinking_budget,
        requested_speed: None,
        cwd: cwd_hdr,
    };
    let est_in_chars = estimate_request_chars(&unified);
    let is_stream = parsed.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let path_str = uri.path().to_string();
    let model_label = requested_model.unwrap_or_else(|| s.default_model.clone());

    if !is_stream {
        match state.router.run_turn(unified, None, None).await {
            Ok(out) => {
                let res = out.turn;
                let bkey = out.backend_key;
                let blabel = out.backend_label;
                let bkind = out.backend_kind;
                let eff = out.effective_effort;
                let mut content = Vec::new();
                if !thinking_disabled && !res.thinking_text.is_empty() {
                    content.push(json!({ "type": "thinking", "thinking": res.thinking_text, "signature": "devin-acp" }));
                }
                if !res.assistant_text.is_empty() {
                    content.push(json!({ "type": "text", "text": res.assistant_text }));
                } else if content.is_empty() {
                    content.push(json!({ "type": "text", "text": "Done." }));
                }

                let in_tok = if res.usage.input_tokens > 0 {
                    res.usage.input_tokens
                } else {
                    estimate_tokens_from_chars(est_in_chars)
                };
                let out_tok = if res.usage.output_tokens > 0 {
                    res.usage.output_tokens
                } else {
                    estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len())
                };
                let (cost_usd, eq_usd) = calculate_costs(&s, bkind, &res.model_id, in_tok, out_tok);

                record_request_log(
                    &state,
                    RequestLogEntry {
                        id: 0,
                        created_at: Utc::now().to_rfc3339(),
                        request_id: req_id.clone(),
                        protocol: "anthropic".into(),
                        method: "POST".into(),
                        path: path_str,
                        model: model_label.clone(),
                        resolved_model: Some(res.model_id.clone()),
                        effort: eff.clone(),
                        backend_key: Some(bkey),
                        account_label: Some(blabel),
                        status: 200,
                        latency_ms: start.elapsed().as_millis() as u64,
                        input_tokens: in_tok,
                        output_tokens: out_tok,
                        cache_read_tokens: res.usage.cache_read_tokens,
                        thinking_tokens: res.usage.thinking_tokens,
                        usage_source: if res.usage.measured { "measured" } else { "estimated" }.into(),
                        cost_usd,
                        api_equivalent_usd: eq_usd,
                        error: None,
                        prompt_preview,
                        response_preview: Some(res.assistant_text.chars().take(180).collect()),
                    },
                );

                Json(json!({
                    "id": req_id,
                    "type": "message",
                    "role": "assistant",
                    "model": res.model_id,
                    "content": content,
                    "stop_reason": res.stop_reason,
                    "stop_sequence": null,
                    "usage": { "input_tokens": in_tok, "output_tokens": out_tok }
                }))
                .into_response()
            }
            Err(err) => {
                record_turn_error(
                    &state,
                    req_id,
                    "anthropic",
                    path_str,
                    model_label,
                    start.elapsed().as_millis() as u64,
                    est_in_chars,
                    prompt_preview,
                    &err,
                );
                anthropic_error(StatusCode::BAD_GATEWAY, "api_error", &err.message)
            }
        }
    } else {
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let (sse_tx, sse_rx) = mpsc::unbounded_channel::<Result<Event, Infallible>>();

        let send_ev = |tx: &mpsc::UnboundedSender<Result<Event, Infallible>>, name: &str, data: Value| {
            let _ = tx.send(Ok(Event::default().event(name).data(data.to_string())));
        };

        send_ev(
            &sse_tx,
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": req_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model_label,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 }
                }
            }),
        );
        send_ev(&sse_tx, "ping", json!({ "type": "ping" }));

        let state_bg = state.clone();
        let req_id_bg = req_id.clone();
        let model_label_bg = model_label.clone();
        let path_bg = path_str.clone();
        let prompt_bg = prompt_preview.clone();
        let settings_bg = s.clone();

        tokio::spawn(async move {
            let cancel_token = crate::cancel::CancelToken::new();
            let router_fut = state_bg.router.run_turn(unified, Some(tx), Some(cancel_token.clone()));
            tokio::pin!(router_fut);

            let mut next_idx = 0usize;
            let mut active_type: Option<&'static str> = None;
            let mut active_idx = 0usize;
            let mut emitted_text = false;
            let mut latest_in = 0u64;
            let mut latest_out = 0u64;
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(15));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            keepalive.tick().await;

            let close_block = |sse_tx: &mpsc::UnboundedSender<Result<Event, Infallible>>,
                               active_type: &mut Option<&'static str>,
                               active_idx: usize| {
                if let Some(t) = *active_type {
                    if t == "thinking" {
                        let _ = sse_tx.send(Ok(Event::default().event("content_block_delta").data(
                            json!({
                                "type": "content_block_delta",
                                "index": active_idx,
                                "delta": { "type": "signature_delta", "signature": "devin-acp" }
                            })
                            .to_string(),
                        )));
                    }
                    let _ = sse_tx.send(Ok(Event::default().event("content_block_stop").data(
                        json!({ "type": "content_block_stop", "index": active_idx }).to_string(),
                    )));
                    *active_type = None;
                }
            };

            let ensure_block = |kind: &'static str,
                                sse_tx: &mpsc::UnboundedSender<Result<Event, Infallible>>,
                                next_idx: &mut usize,
                                active_type: &mut Option<&'static str>,
                                active_idx: &mut usize| {
                if *active_type == Some(kind) {
                    return;
                }
                close_block(sse_tx, active_type, *active_idx);
                *active_idx = *next_idx;
                *next_idx += 1;
                *active_type = Some(kind);
                let cb = if kind == "thinking" {
                    json!({ "type": "thinking", "thinking": "" })
                } else {
                    json!({ "type": "text", "text": "" })
                };
                let _ = sse_tx.send(Ok(Event::default().event("content_block_start").data(
                    json!({
                        "type": "content_block_start",
                        "index": *active_idx,
                        "content_block": cb
                    })
                    .to_string(),
                )));
            };

            let turn_result;
            let mut rx_open = true;
            let mut downstream_open = true;
            loop {
                tokio::select! {
                    biased;
                    _ = sse_tx.closed(), if downstream_open => {
                        downstream_open = false;
                        cancel_token.cancel();
                    }
                    res = &mut router_fut => {
                        turn_result = res;
                        break;
                    }
                    ev = rx.recv(), if rx_open => {
                        match ev {
                            Some(StreamEvent::Thinking(chunk)) if !thinking_disabled && !chunk.is_empty() => {
                                ensure_block("thinking", &sse_tx, &mut next_idx, &mut active_type, &mut active_idx);
                                let _ = sse_tx.send(Ok(Event::default().event("content_block_delta").data(
                                    json!({
                                        "type": "content_block_delta",
                                        "index": active_idx,
                                        "delta": { "type": "thinking_delta", "thinking": chunk }
                                    }).to_string()
                                )));
                            }
                            Some(StreamEvent::Text(chunk)) if !chunk.is_empty() => {
                                emitted_text = true;
                                ensure_block("text", &sse_tx, &mut next_idx, &mut active_type, &mut active_idx);
                                let _ = sse_tx.send(Ok(Event::default().event("content_block_delta").data(
                                    json!({
                                        "type": "content_block_delta",
                                        "index": active_idx,
                                        "delta": { "type": "text_delta", "text": chunk }
                                    }).to_string()
                                )));
                            }
                            Some(StreamEvent::Usage { input_tokens, output_tokens }) => {
                                latest_in = input_tokens;
                                latest_out = output_tokens;
                            }
                            Some(_) => {}
                            None => { rx_open = false; }
                        }
                    }
                    _ = keepalive.tick(), if downstream_open => {
                        let _ = sse_tx.send(Ok(Event::default().event("ping").data(
                            json!({ "type": "ping" }).to_string(),
                        )));
                    }
                }
            }

            // Drain any remaining buffered events
            while let Ok(ev) = rx.try_recv() {
                match ev {
                    StreamEvent::Thinking(chunk) if !thinking_disabled && !chunk.is_empty() => {
                        ensure_block("thinking", &sse_tx, &mut next_idx, &mut active_type, &mut active_idx);
                        let _ = sse_tx.send(Ok(Event::default().event("content_block_delta").data(
                            json!({
                                "type": "content_block_delta",
                                "index": active_idx,
                                "delta": { "type": "thinking_delta", "thinking": chunk }
                            }).to_string()
                        )));
                    }
                    StreamEvent::Text(chunk) if !chunk.is_empty() => {
                        emitted_text = true;
                        ensure_block("text", &sse_tx, &mut next_idx, &mut active_type, &mut active_idx);
                        let _ = sse_tx.send(Ok(Event::default().event("content_block_delta").data(
                            json!({
                                "type": "content_block_delta",
                                "index": active_idx,
                                "delta": { "type": "text_delta", "text": chunk }
                            }).to_string()
                        )));
                    }
                    StreamEvent::Usage { input_tokens, output_tokens } => {
                        latest_in = input_tokens;
                        latest_out = output_tokens;
                    }
                    _ => {}
                }
            }

            match turn_result {
                Ok(out) => {
                    let res = out.turn;
                    let bkey = out.backend_key;
                    let blabel = out.backend_label;
                    let bkind = out.backend_kind;
                    let eff = out.effective_effort;
                    if !emitted_text && next_idx == 0 {
                        ensure_block("text", &sse_tx, &mut next_idx, &mut active_type, &mut active_idx);
                        let _ = sse_tx.send(Ok(Event::default().event("content_block_delta").data(
                            json!({
                                "type": "content_block_delta",
                                "index": active_idx,
                                "delta": { "type": "text_delta", "text": "Done." }
                            }).to_string()
                        )));
                    }
                    close_block(&sse_tx, &mut active_type, active_idx);

                    let in_tok = if res.usage.input_tokens > 0 {
                        res.usage.input_tokens
                    } else if latest_in > 0 {
                        latest_in
                    } else {
                        estimate_tokens_from_chars(est_in_chars)
                    };
                    let out_tok = if res.usage.output_tokens > 0 {
                        res.usage.output_tokens
                    } else if latest_out > 0 {
                        latest_out
                    } else {
                        estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len())
                    };
                    let (cost_usd, eq_usd) = calculate_costs(&settings_bg, bkind, &res.model_id, in_tok, out_tok);

                    let _ = sse_tx.send(Ok(Event::default().event("message_delta").data(
                        json!({
                            "type": "message_delta",
                            "delta": { "stop_reason": res.stop_reason, "stop_sequence": null },
                            "usage": { "input_tokens": in_tok, "output_tokens": out_tok }
                        }).to_string()
                    )));
                    let _ = sse_tx.send(Ok(Event::default().event("message_stop").data(
                        json!({ "type": "message_stop" }).to_string()
                    )));

                    record_request_log(
                        &state_bg,
                        RequestLogEntry {
                            id: 0,
                            created_at: Utc::now().to_rfc3339(),
                            request_id: req_id_bg,
                            protocol: "anthropic".into(),
                            method: "POST".into(),
                            path: path_bg,
                            model: model_label_bg,
                            resolved_model: Some(res.model_id.clone()),
                            effort: eff.clone(),
                            backend_key: Some(bkey),
                            account_label: Some(blabel),
                            status: 200,
                            latency_ms: start.elapsed().as_millis() as u64,
                            input_tokens: in_tok,
                            output_tokens: out_tok,
                            cache_read_tokens: res.usage.cache_read_tokens,
                            thinking_tokens: res.usage.thinking_tokens,
                            usage_source: if res.usage.measured || latest_in > 0 { "measured" } else { "estimated" }.into(),
                            cost_usd,
                            api_equivalent_usd: eq_usd,
                            error: None,
                            prompt_preview: prompt_bg,
                            response_preview: Some(res.assistant_text.chars().take(180).collect()),
                        },
                    );
                }
                Err(err) => {
                    close_block(&sse_tx, &mut active_type, active_idx);
                    let _ = sse_tx.send(Ok(Event::default().event("error").data(
                        json!({ "type": "error", "error": { "type": "api_error", "message": err.message } }).to_string()
                    )));
                    record_turn_error(
                        &state_bg,
                        req_id_bg,
                        "anthropic",
                        path_bg,
                        model_label_bg,
                        start.elapsed().as_millis() as u64,
                        est_in_chars,
                        prompt_bg,
                        &err,
                    );
                }
            }
        });

        let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(sse_rx);
        Sse::new(stream)
            .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
            .into_response()
    }
}

async fn openai_chat_handler(
    State(state): State<HttpSharedState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let req_id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let s = state.settings.read().await.clone();
    if !check_auth(&headers, &s.api_key) {
        return openai_error(StatusCode::UNAUTHORIZED, "invalid_request_error", "Invalid API key.");
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return openai_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Invalid JSON body."),
    };
    let Some(msgs_arr) = parsed.get("messages").and_then(|v| v.as_array()) else {
        return openai_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Field 'messages' is required.");
    };

    let requested_model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());

    let mut sys_parts = Vec::new();
    let mut messages = Vec::new();
    for m in msgs_arr {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let (text, images) = normalize_openai_content(m.get("content"));
        if role == "system" || role == "developer" {
            if !text.is_empty() {
                sys_parts.push(text);
            }
        } else {
            messages.push(NormalizedMessage {
                role: if role == "assistant" { "assistant" } else { "user" }.to_string(),
                text,
                images,
            });
        }
    }
    let prompt_preview = messages.last().map(|m| m.text.chars().take(180).collect::<String>());
    let requested_effort = normalize_effort_value(
        parsed
            .get("reasoning_effort")
            .or_else(|| parsed.get("reasoning").and_then(|r| r.get("effort")))
            .and_then(|v| v.as_str()),
    );
    let unified = UnifiedTurnRequest {
        model: requested_model.clone(),
        system: sys_parts.join("\n\n"),
        messages,
        requested_effort,
        thinking_disabled: false,
        thinking_budget: None,
        requested_speed: None,
        cwd: None,
    };
    let est_in_chars = estimate_request_chars(&unified);
    let is_stream = parsed.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let path_str = uri.path().to_string();
    let model_label = requested_model.unwrap_or_else(|| s.default_model.clone());
    let created = Utc::now().timestamp();

    if !is_stream {
        match state.router.run_turn(unified, None, None).await {
            Ok(out) => {
                let res = out.turn;
                let bkey = out.backend_key;
                let blabel = out.backend_label;
                let bkind = out.backend_kind;
                let resolved_qid = out.resolved_qid;
                let eff = out.effective_effort;
                let in_tok = if res.usage.input_tokens > 0 { res.usage.input_tokens } else { estimate_tokens_from_chars(est_in_chars) };
                let out_tok = if res.usage.output_tokens > 0 { res.usage.output_tokens } else { estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len()) };
                let (cost_usd, eq_usd) = calculate_costs(&s, bkind, &res.model_id, in_tok, out_tok);

                record_request_log(
                    &state,
                    RequestLogEntry {
                        id: 0,
                        created_at: Utc::now().to_rfc3339(),
                        request_id: req_id.clone(),
                        protocol: "openai-chat".into(),
                        method: "POST".into(),
                        path: path_str,
                        model: model_label,
                        resolved_model: Some(res.model_id.clone()),
                        effort: eff.clone(),
                        backend_key: Some(bkey),
                        account_label: Some(blabel),
                        status: 200,
                        latency_ms: start.elapsed().as_millis() as u64,
                        input_tokens: in_tok,
                        output_tokens: out_tok,
                        cache_read_tokens: res.usage.cache_read_tokens,
                        thinking_tokens: res.usage.thinking_tokens,
                        usage_source: if res.usage.measured { "measured" } else { "estimated" }.into(),
                        cost_usd,
                        api_equivalent_usd: eq_usd,
                        error: None,
                        prompt_preview,
                        response_preview: Some(res.assistant_text.chars().take(180).collect()),
                    },
                );

                let mut msg_obj = json!({
                    "role": "assistant",
                    "content": res.assistant_text
                });
                if !res.thinking_text.is_empty() {
                    msg_obj["reasoning_content"] = json!(res.thinking_text);
                }

                Json(json!({
                    "id": req_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": resolved_qid,
                    "choices": [{
                        "index": 0,
                        "message": msg_obj,
                        "finish_reason": if res.stop_reason == "max_tokens" { "length" } else { "stop" }
                    }],
                    "usage": {
                        "prompt_tokens": in_tok,
                        "completion_tokens": out_tok,
                        "total_tokens": in_tok + out_tok
                    }
                }))
                .into_response()
            }
            Err(err) => {
                record_turn_error(
                    &state,
                    req_id,
                    "openai-chat",
                    path_str,
                    model_label,
                    start.elapsed().as_millis() as u64,
                    est_in_chars,
                    prompt_preview,
                    &err,
                );
                openai_error(StatusCode::BAD_GATEWAY, "server_error", &err.message)
            }
        }
    } else {
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let (sse_tx, sse_rx) = mpsc::unbounded_channel::<Result<Event, Infallible>>();

        let state_bg = state.clone();
        let req_id_bg = req_id.clone();
        let model_label_bg = model_label.clone();
        let path_bg = path_str.clone();
        let prompt_bg = prompt_preview.clone();
        let settings_bg = s.clone();

        tokio::spawn(async move {
            let cancel_token = crate::cancel::CancelToken::new();
            let router_fut = state_bg.router.run_turn(unified, Some(tx), Some(cancel_token.clone()));
            tokio::pin!(router_fut);
            let mut latest_in = 0u64;
            let mut latest_out = 0u64;
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(15));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            keepalive.tick().await;
            let mut rx_open = true;
            let mut downstream_open = true;
            let turn_result;

            let _ = sse_tx.send(Ok(Event::default().data(
                json!({
                    "id": req_id_bg,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_label_bg,
                    "choices": [{ "index": 0, "delta": { "role": "assistant" }, "finish_reason": null }]
                }).to_string()
            )));

            loop {
                tokio::select! {
                    biased;
                    _ = sse_tx.closed(), if downstream_open => {
                        downstream_open = false;
                        cancel_token.cancel();
                    }
                    res = &mut router_fut => {
                        turn_result = res;
                        break;
                    }
                    ev = rx.recv(), if rx_open => {
                        match ev {
                            Some(StreamEvent::Thinking(chunk)) if !chunk.is_empty() => {
                                let _ = sse_tx.send(Ok(Event::default().data(
                                    json!({
                                        "id": req_id_bg,
                                        "object": "chat.completion.chunk",
                                        "created": created,
                                        "model": model_label_bg,
                                        "choices": [{ "index": 0, "delta": { "reasoning_content": chunk }, "finish_reason": null }]
                                    }).to_string()
                                )));
                            }
                            Some(StreamEvent::Text(chunk)) if !chunk.is_empty() => {
                                let _ = sse_tx.send(Ok(Event::default().data(
                                    json!({
                                        "id": req_id_bg,
                                        "object": "chat.completion.chunk",
                                        "created": created,
                                        "model": model_label_bg,
                                        "choices": [{ "index": 0, "delta": { "content": chunk }, "finish_reason": null }]
                                    }).to_string()
                                )));
                            }
                            Some(StreamEvent::Usage { input_tokens, output_tokens }) => {
                                latest_in = input_tokens;
                                latest_out = output_tokens;
                            }
                            Some(_) => {}
                            None => { rx_open = false; }
                        }
                    }
                    _ = keepalive.tick(), if downstream_open => {
                        let _ = sse_tx.send(Ok(Event::default().comment("keepalive")));
                    }
                }
            }

            while let Ok(ev) = rx.try_recv() {
                if let StreamEvent::Text(chunk) = ev {
                    if !chunk.is_empty() {
                        let _ = sse_tx.send(Ok(Event::default().data(
                            json!({
                                "id": req_id_bg,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model_label_bg,
                                "choices": [{ "index": 0, "delta": { "content": chunk }, "finish_reason": null }]
                            }).to_string()
                        )));
                    }
                }
            }

            match turn_result {
                Ok(out) => {
                    let res = out.turn;
                    let bkey = out.backend_key;
                    let blabel = out.backend_label;
                    let bkind = out.backend_kind;
                    let resolved_qid = out.resolved_qid;
                    let eff = out.effective_effort;
                    let in_tok = if res.usage.input_tokens > 0 { res.usage.input_tokens } else if latest_in > 0 { latest_in } else { estimate_tokens_from_chars(est_in_chars) };
                    let out_tok = if res.usage.output_tokens > 0 { res.usage.output_tokens } else if latest_out > 0 { latest_out } else { estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len()) };
                    let (cost_usd, eq_usd) = calculate_costs(&settings_bg, bkind, &res.model_id, in_tok, out_tok);

                    let _ = sse_tx.send(Ok(Event::default().data(
                        json!({
                            "id": req_id_bg,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": resolved_qid,
                            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
                            "usage": { "prompt_tokens": in_tok, "completion_tokens": out_tok, "total_tokens": in_tok + out_tok }
                        }).to_string()
                    )));
                    let _ = sse_tx.send(Ok(Event::default().data("[DONE]")));

                    record_request_log(
                        &state_bg,
                        RequestLogEntry {
                            id: 0,
                            created_at: Utc::now().to_rfc3339(),
                            request_id: req_id_bg,
                            protocol: "openai-chat".into(),
                            method: "POST".into(),
                            path: path_bg,
                            model: model_label_bg,
                            resolved_model: Some(res.model_id.clone()),
                            effort: eff.clone(),
                            backend_key: Some(bkey),
                            account_label: Some(blabel),
                            status: 200,
                            latency_ms: start.elapsed().as_millis() as u64,
                            input_tokens: in_tok,
                            output_tokens: out_tok,
                            cache_read_tokens: res.usage.cache_read_tokens,
                            thinking_tokens: res.usage.thinking_tokens,
                            usage_source: if res.usage.measured || latest_in > 0 { "measured" } else { "estimated" }.into(),
                            cost_usd,
                            api_equivalent_usd: eq_usd,
                            error: None,
                            prompt_preview: prompt_bg,
                            response_preview: Some(res.assistant_text.chars().take(180).collect()),
                        },
                    );
                }
                Err(err) => {
                    let _ = sse_tx.send(Ok(Event::default().data(
                        json!({ "error": { "message": err.message, "type": "server_error" } }).to_string()
                    )));
                    let _ = sse_tx.send(Ok(Event::default().data("[DONE]")));
                    record_turn_error(
                        &state_bg,
                        req_id_bg,
                        "openai-chat",
                        path_bg,
                        model_label_bg,
                        start.elapsed().as_millis() as u64,
                        est_in_chars,
                        prompt_bg,
                        &err,
                    );
                }
            }
        });

        let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(sse_rx);
        Sse::new(stream)
            .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
            .into_response()
    }
}

async fn openai_responses_handler(
    State(state): State<HttpSharedState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let resp_id = format!("resp_{}", uuid::Uuid::new_v4().simple());
    let msg_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let s = state.settings.read().await.clone();
    if !check_auth(&headers, &s.api_key) {
        return openai_error(StatusCode::UNAUTHORIZED, "invalid_request_error", "Invalid API key.");
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return openai_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Invalid JSON body."),
    };

    let requested_model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());

    let instructions = parsed
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut messages = Vec::new();
    if let Some(inp) = parsed.get("input") {
        if let Some(txt) = inp.as_str() {
            messages.push(NormalizedMessage {
                role: "user".into(),
                text: txt.to_string(),
                images: Vec::new(),
            });
        } else if let Some(arr) = inp.as_array() {
            for item in arr {
                let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("message");
                if item_type == "message" || item.get("role").is_some() {
                    let role = item.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                    let (text, images) = normalize_openai_content(item.get("content"));
                    if !text.is_empty() || !images.is_empty() {
                        messages.push(NormalizedMessage {
                            role: if role == "assistant" { "assistant" } else { "user" }.into(),
                            text,
                            images,
                        });
                    }
                } else if item_type == "function_call_output" {
                    let out = item.get("output").and_then(|o| o.as_str()).unwrap_or("");
                    messages.push(NormalizedMessage {
                        role: "user".into(),
                        text: format!("[Tool Result]\n{out}"),
                        images: Vec::new(),
                    });
                }
            }
        }
    }
    if messages.is_empty() {
        messages.push(NormalizedMessage { role: "user".into(), text: "Continue.".into(), images: Vec::new() });
    }

    let prompt_preview = messages.last().map(|m| m.text.chars().take(180).collect::<String>());
    let requested_effort = normalize_effort_value(
        parsed
            .get("reasoning")
            .and_then(|r| r.get("effort"))
            .and_then(|v| v.as_str()),
    );
    let unified = UnifiedTurnRequest {
        model: requested_model.clone(),
        system: instructions,
        messages,
        requested_effort,
        thinking_disabled: false,
        thinking_budget: None,
        requested_speed: None,
        cwd: None,
    };
    let est_in_chars = estimate_request_chars(&unified);
    let is_stream = parsed.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let path_str = uri.path().to_string();
    let model_label = requested_model.unwrap_or_else(|| s.default_model.clone());
    let created_at = Utc::now().timestamp();

    if !is_stream {
        match state.router.run_turn(unified, None, None).await {
            Ok(out) => {
                let res = out.turn;
                let bkey = out.backend_key;
                let blabel = out.backend_label;
                let bkind = out.backend_kind;
                let resolved_qid = out.resolved_qid;
                let eff = out.effective_effort;
                let in_tok = if res.usage.input_tokens > 0 { res.usage.input_tokens } else { estimate_tokens_from_chars(est_in_chars) };
                let out_tok = if res.usage.output_tokens > 0 { res.usage.output_tokens } else { estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len()) };
                let (cost_usd, eq_usd) = calculate_costs(&s, bkind, &res.model_id, in_tok, out_tok);

                record_request_log(
                    &state,
                    RequestLogEntry {
                        id: 0,
                        created_at: Utc::now().to_rfc3339(),
                        request_id: resp_id.clone(),
                        protocol: "openai-responses".into(),
                        method: "POST".into(),
                        path: path_str,
                        model: model_label,
                        resolved_model: Some(res.model_id.clone()),
                        effort: eff.clone(),
                        backend_key: Some(bkey),
                        account_label: Some(blabel),
                        status: 200,
                        latency_ms: start.elapsed().as_millis() as u64,
                        input_tokens: in_tok,
                        output_tokens: out_tok,
                        cache_read_tokens: res.usage.cache_read_tokens,
                        thinking_tokens: res.usage.thinking_tokens,
                        usage_source: if res.usage.measured { "measured" } else { "estimated" }.into(),
                        cost_usd,
                        api_equivalent_usd: eq_usd,
                        error: None,
                        prompt_preview,
                        response_preview: Some(res.assistant_text.chars().take(180).collect()),
                    },
                );

                Json(json!({
                    "id": resp_id,
                    "object": "response",
                    "created_at": created_at,
                    "status": "completed",
                    "model": resolved_qid,
                    "output": [{
                        "id": msg_id,
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{
                            "type": "output_text",
                            "text": res.assistant_text,
                            "annotations": []
                        }]
                    }],
                    "output_text": res.assistant_text,
                    "usage": {
                        "input_tokens": in_tok,
                        "output_tokens": out_tok,
                        "total_tokens": in_tok + out_tok
                    }
                }))
                .into_response()
            }
            Err(err) => {
                record_turn_error(
                    &state,
                    resp_id,
                    "openai-responses",
                    path_str,
                    model_label,
                    start.elapsed().as_millis() as u64,
                    est_in_chars,
                    prompt_preview,
                    &err,
                );
                openai_error(StatusCode::BAD_GATEWAY, "server_error", &err.message)
            }
        }
    } else {
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let (sse_tx, sse_rx) = mpsc::unbounded_channel::<Result<Event, Infallible>>();

        let state_bg = state.clone();
        let resp_id_bg = resp_id.clone();
        let msg_id_bg = msg_id.clone();
        let model_label_bg = model_label.clone();
        let path_bg = path_str.clone();
        let prompt_bg = prompt_preview.clone();
        let settings_bg = s.clone();

        tokio::spawn(async move {
            let emit = |ev_name: &str, data: Value| {
                let _ = sse_tx.send(Ok(Event::default().event(ev_name).data(data.to_string())));
            };

            emit("response.created", json!({
                "type": "response.created",
                "response": { "id": resp_id_bg, "object": "response", "created_at": created_at, "status": "in_progress", "model": model_label_bg, "output": [] }
            }));
            emit("response.output_item.added", json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "id": msg_id_bg, "type": "message", "status": "in_progress", "role": "assistant", "content": [] }
            }));
            emit("response.content_part.added", json!({
                "type": "response.content_part.added",
                "item_id": msg_id_bg,
                "output_index": 0,
                "content_index": 0,
                "part": { "type": "output_text", "text": "", "annotations": [] }
            }));

            let cancel_token = crate::cancel::CancelToken::new();
            let router_fut = state_bg.router.run_turn(unified, Some(tx), Some(cancel_token.clone()));
            tokio::pin!(router_fut);
            let mut latest_in = 0u64;
            let mut latest_out = 0u64;
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(15));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            keepalive.tick().await;
            let mut rx_open = true;
            let mut downstream_open = true;
            let turn_result;

            loop {
                tokio::select! {
                    biased;
                    _ = sse_tx.closed(), if downstream_open => {
                        downstream_open = false;
                        cancel_token.cancel();
                    }
                    res = &mut router_fut => {
                        turn_result = res;
                        break;
                    }
                    ev = rx.recv(), if rx_open => {
                        match ev {
                            Some(StreamEvent::Thinking(chunk)) if !chunk.is_empty() => {
                                emit("response.reasoning_summary_text.delta", json!({
                                    "type": "response.reasoning_summary_text.delta",
                                    "delta": chunk
                                }));
                            }
                            Some(StreamEvent::Text(chunk)) if !chunk.is_empty() => {
                                emit("response.output_text.delta", json!({
                                    "type": "response.output_text.delta",
                                    "item_id": msg_id_bg,
                                    "output_index": 0,
                                    "content_index": 0,
                                    "delta": chunk
                                }));
                            }
                            Some(StreamEvent::Usage { input_tokens, output_tokens }) => {
                                latest_in = input_tokens;
                                latest_out = output_tokens;
                            }
                            Some(_) => {}
                            None => { rx_open = false; }
                        }
                    }
                    _ = keepalive.tick(), if downstream_open => {
                        let _ = sse_tx.send(Ok(Event::default().comment("keepalive")));
                    }
                }
            }

            while let Ok(ev) = rx.try_recv() {
                if let StreamEvent::Text(chunk) = ev {
                    if !chunk.is_empty() {
                        emit("response.output_text.delta", json!({
                            "type": "response.output_text.delta",
                            "item_id": msg_id_bg,
                            "output_index": 0,
                            "content_index": 0,
                            "delta": chunk
                        }));
                    }
                }
            }

            match turn_result {
                Ok(out) => {
                    let res = out.turn;
                    let bkey = out.backend_key;
                    let blabel = out.backend_label;
                    let bkind = out.backend_kind;
                    let resolved_qid = out.resolved_qid;
                    let eff = out.effective_effort;
                    let in_tok = if res.usage.input_tokens > 0 { res.usage.input_tokens } else if latest_in > 0 { latest_in } else { estimate_tokens_from_chars(est_in_chars) };
                    let out_tok = if res.usage.output_tokens > 0 { res.usage.output_tokens } else if latest_out > 0 { latest_out } else { estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len()) };
                    let (cost_usd, eq_usd) = calculate_costs(&settings_bg, bkind, &res.model_id, in_tok, out_tok);

                    emit("response.output_text.done", json!({
                        "type": "response.output_text.done",
                        "item_id": msg_id_bg,
                        "output_index": 0,
                        "content_index": 0,
                        "text": res.assistant_text
                    }));
                    emit("response.completed", json!({
                        "type": "response.completed",
                        "response": {
                            "id": resp_id_bg,
                            "object": "response",
                            "created_at": created_at,
                            "status": "completed",
                            "model": resolved_qid,
                            "output": [{
                                "id": msg_id_bg,
                                "type": "message",
                                "status": "completed",
                                "role": "assistant",
                                "content": [{ "type": "output_text", "text": res.assistant_text, "annotations": [] }]
                            }],
                            "usage": { "input_tokens": in_tok, "output_tokens": out_tok, "total_tokens": in_tok + out_tok }
                        }
                    }));

                    record_request_log(
                        &state_bg,
                        RequestLogEntry {
                            id: 0,
                            created_at: Utc::now().to_rfc3339(),
                            request_id: resp_id_bg,
                            protocol: "openai-responses".into(),
                            method: "POST".into(),
                            path: path_bg,
                            model: model_label_bg,
                            resolved_model: Some(res.model_id.clone()),
                            effort: eff.clone(),
                            backend_key: Some(bkey),
                            account_label: Some(blabel),
                            status: 200,
                            latency_ms: start.elapsed().as_millis() as u64,
                            input_tokens: in_tok,
                            output_tokens: out_tok,
                            cache_read_tokens: res.usage.cache_read_tokens,
                            thinking_tokens: res.usage.thinking_tokens,
                            usage_source: if res.usage.measured || latest_in > 0 { "measured" } else { "estimated" }.into(),
                            cost_usd,
                            api_equivalent_usd: eq_usd,
                            error: None,
                            prompt_preview: prompt_bg,
                            response_preview: Some(res.assistant_text.chars().take(180).collect()),
                        },
                    );
                }
                Err(err) => {
                    emit("response.failed", json!({
                        "type": "response.failed",
                        "response": { "id": resp_id_bg, "status": "failed", "error": { "message": err.message } }
                    }));
                    record_turn_error(
                        &state_bg,
                        resp_id_bg,
                        "openai-responses",
                        path_bg,
                        model_label_bg,
                        start.elapsed().as_millis() as u64,
                        est_in_chars,
                        prompt_bg,
                        &err,
                    );
                }
            }
        });

        let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(sse_rx);
        Sse::new(stream)
            .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
            .into_response()
    }
}

pub fn build_http_router(state: HttpSharedState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS]);

    Router::new()
        .route("/", get(health_handler))
        .route("/health", get(health_handler))
        .route("/v1/models", get(models_handler))
        .route("/models", get(models_handler))
        .route("/openai/v1/models", get(models_handler))
        .route("/v1/messages", post(anthropic_messages_handler))
        .route("/messages", post(anthropic_messages_handler))
        .route("/v1/messages/count_tokens", post(count_tokens_handler))
        .route("/messages/count_tokens", post(count_tokens_handler))
        .route("/v1/chat/completions", post(openai_chat_handler))
        .route("/chat/completions", post(openai_chat_handler))
        .route("/openai/v1/chat/completions", post(openai_chat_handler))
        .route("/v1/responses", post(openai_responses_handler))
        .route("/responses", post(openai_responses_handler))
        .route("/openai/v1/responses", post(openai_responses_handler))
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp_client::LogFn;
    use crate::types::AppSettings;

    fn make_test_state(api_key: Option<String>) -> HttpSharedState {
        let dir = std::env::temp_dir().join(format!("ai-proxy-http-test-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(AppDb::open(&dir.join("test.db")).unwrap());
        let mut s = AppSettings::default();
        s.api_key = api_key;
        s.enable_devin = false;
        s.enable_antigravity = false;
        s.enable_opencode = false;
        s.enable_grok = false;
        s.enable_codex = false;
        let settings = Arc::new(RwLock::new(s));
        let log: LogFn = Arc::new(|_, _, _| {});
        let router = BackendRouter::new(settings.clone(), log);
        HttpSharedState {
            router,
            settings,
            db,
            on_request_log: None,
            force_openai: false,
        }
    }

    #[tokio::test]
    async fn http_health_models_auth_and_count_tokens() {
        let state = make_test_state(Some("secret-123".into()));
        let app = build_http_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();
        let base = format!("http://{addr}");

        let health = client.get(format!("{base}/health")).send().await.unwrap();
        assert_eq!(health.status(), 200);
        let h_json: Value = health.json().await.unwrap();
        assert_eq!(h_json["ok"], true);

        let unauth = client.get(format!("{base}/v1/models")).send().await.unwrap();
        assert_eq!(unauth.status(), 401);

        let anth_models = client
            .get(format!("{base}/v1/models"))
            .header("x-api-key", "secret-123")
            .send()
            .await
            .unwrap();
        assert_eq!(anth_models.status(), 200);
        let am_json: Value = anth_models.json().await.unwrap();
        assert_eq!(am_json["has_more"], false);

        let oai_models = client
            .get(format!("{base}/openai/v1/models"))
            .header("Authorization", "Bearer secret-123")
            .send()
            .await
            .unwrap();
        assert_eq!(oai_models.status(), 200);
        let om_json: Value = oai_models.json().await.unwrap();
        assert_eq!(om_json["object"], "list");

        let count_res = client
            .post(format!("{base}/v1/messages/count_tokens"))
            .header("x-api-key", "secret-123")
            .json(&json!({ "messages": [{ "role": "user", "content": "Hello world from Rust proxy!" }] }))
            .send()
            .await
            .unwrap();
        assert_eq!(count_res.status(), 200);
        let c_json: Value = count_res.json().await.unwrap();
        assert!(c_json["input_tokens"].as_u64().unwrap() >= 1);

        server.abort();
    }

    struct HangingUpstream {
        addr: std::net::SocketAddr,
        disconnects: mpsc::UnboundedReceiver<()>,
        task: tokio::task::JoinHandle<()>,
    }

    async fn start_hanging_upstream(continuous: bool) -> HangingUpstream {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (disconnect_tx, disconnects) = mpsc::unbounded_channel::<()>();

        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let disconnect_tx = disconnect_tx.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::with_capacity(4096);
                    let mut tmp = [0u8; 4096];
                    let header_end = loop {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if let Some(pos) = buf
                                    .windows(4)
                                    .position(|w| w == b"\r\n\r\n")
                                    .map(|p| p + 4)
                                {
                                    break pos;
                                }
                                if buf.len() > 64 * 1024 {
                                    return;
                                }
                            }
                        }
                    };

                    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
                    let path = header
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("");

                    if path.ends_with("/models") {
                        let body = r#"{"object":"list","data":[{"id":"slow-model","object":"model","created":0,"owned_by":"test"}]}"#;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                        return;
                    }

                    if !path.ends_with("/chat/completions") {
                        let body = "not found";
                        let response = format!(
                            "HTTP/1.1 404 Not Found\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                        return;
                    }

                    let content_len = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    while buf.len() < header_end + content_len {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }

                    let sse = concat!(
                        "data: {\"id\":\"up\",\"object\":\"chat.completion.chunk\",\"created\":0,",
                        "\"model\":\"slow-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n"
                    );
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
                    if socket.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    let first_chunk = format!("{:X}\r\n{}\r\n", sse.len(), sse);
                    if socket.write_all(first_chunk.as_bytes()).await.is_err() {
                        return;
                    }
                    let _ = socket.flush().await;

                    if continuous {
                        let mut seq = 0u64;
                        loop {
                            seq += 1;
                            let event = format!(
                                "data: {{\"id\":\"up\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"slow-model\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\".{seq}\"}},\"finish_reason\":null}}]}}\n\n"
                            );
                            let chunk = format!("{:X}\r\n{}\r\n", event.len(), event);
                            if socket.write_all(chunk.as_bytes()).await.is_err() {
                                let _ = disconnect_tx.send(());
                                return;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                        }
                    }

                    loop {
                        match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => {
                                let _ = disconnect_tx.send(());
                                return;
                            }
                            Ok(_) => {}
                        }
                    }
                });
            }
        });

        HangingUpstream {
            addr,
            disconnects,
            task,
        }
    }

    async fn start_proxy_with_hanging_upstream() -> (
        HangingUpstream,
        std::net::SocketAddr,
        String,
        tokio::task::JoinHandle<()>,
    ) {
        let upstream = start_hanging_upstream(true).await;

        let mut s = AppSettings::default();
        s.api_key = Some("secret-123".into());
        s.enable_devin = false;
        s.enable_antigravity = false;
        s.enable_opencode = false;
        s.enable_grok = false;
        s.enable_codex = false;
        s.enable_copilot = false;
        s.enable_cursor = false;
        s.enable_cline = false;
        s.enable_mistral = false;
        s.enable_kimi = false;
        s.enable_hermes = false;
        s.external_providers = vec![crate::types::ExternalProviderConfig {
            id: "test".into(),
            display_name: "Test upstream".into(),
            base_url: format!("http://{}", upstream.addr),
            api_key: None,
            enabled: true,
            proxy_mode: crate::types::ProxyMode::Disabled,
            proxy_url: None,
            extra_headers: Default::default(),
            max_output_tokens: None,
        }];

        let settings = Arc::new(RwLock::new(s));
        let log: LogFn = Arc::new(|_, _, _| {});
        let router = BackendRouter::new(settings.clone(), log);
        router.rebuild_backends().await;
        let models = router.warm_up(true).await;
        assert!(!models.is_empty(), "test upstream did not expose models");
        let model = models[0].gateway_id.clone();

        let dir = std::env::temp_dir().join(format!("ai-proxy-http-test-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(AppDb::open(&dir.join("test.db")).unwrap());
        let state = HttpSharedState {
            router,
            settings,
            db,
            on_request_log: None,
            force_openai: false,
        };
        let app = build_http_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        (upstream, addr, model, server)
    }

    async fn read_until_upstream_content<S, B, E>(stream: &mut S)
    where
        S: futures::Stream<Item = Result<B, E>> + Unpin,
        B: AsRef<[u8]>,
        E: std::fmt::Debug,
    {
        use futures::StreamExt;
        let mut saw_content = false;
        for _ in 0..10 {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                .await
                .expect("proxy did not emit an SSE chunk")
                .expect("SSE stream ended before upstream content")
                .expect("SSE chunk read failed");
            let text = String::from_utf8_lossy(chunk.as_ref());
            if text.contains("\"hi\"") || text.contains("\\\"hi\\\"") || text.contains("\"content\":\"hi\"") {
                saw_content = true;
                break;
            }
        }
        assert!(saw_content, "proxy did not forward content from the active upstream turn");
    }

    async fn assert_upstream_disconnects(mut upstream: HangingUpstream) {
        tokio::time::timeout(std::time::Duration::from_secs(4), upstream.disconnects.recv())
            .await
            .expect("upstream connection stayed open after the downstream SSE client disconnected")
            .expect("upstream disconnect channel closed");
        upstream.task.abort();
    }

    #[tokio::test]
    async fn streaming_client_disconnect_cancels_upstream_turn() {
        let (upstream, addr, model, server) = start_proxy_with_hanging_upstream().await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", "Bearer secret-123")
            .json(&json!({
                "model": model,
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let mut stream = resp.bytes_stream();
        read_until_upstream_content(&mut stream).await;
        drop(stream);

        assert_upstream_disconnects(upstream).await;
        server.abort();
    }

    #[tokio::test]
    async fn anthropic_streaming_client_disconnect_cancels_upstream_turn() {
        let (upstream, addr, model, server) = start_proxy_with_hanging_upstream().await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://{addr}/v1/messages"))
            .header("x-api-key", "secret-123")
            .json(&json!({
                "model": model,
                "max_tokens": 1024,
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let mut stream = resp.bytes_stream();
        read_until_upstream_content(&mut stream).await;
        drop(stream);

        assert_upstream_disconnects(upstream).await;
        server.abort();
    }

    #[tokio::test]
    async fn responses_streaming_client_disconnect_cancels_upstream_turn() {
        let (upstream, addr, model, server) = start_proxy_with_hanging_upstream().await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://{addr}/v1/responses"))
            .header("Authorization", "Bearer secret-123")
            .json(&json!({
                "model": model,
                "input": "hi",
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        let mut stream = resp.bytes_stream();
        read_until_upstream_content(&mut stream).await;
        drop(stream);

        assert_upstream_disconnects(upstream).await;
        server.abort();
    }
}

