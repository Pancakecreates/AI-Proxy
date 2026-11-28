use serde_json::{json, Value};
use std::collections::HashMap;

const TOOL_DETAIL_MAX_CHARS: usize = 140;
const TOOL_OUTPUT_MAX_CHARS: usize = 700;
const TOOL_PROGRESS_MAX_CHARS: usize = 240;

fn clean_text(text: &str) -> Option<String> {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact)
    }
}

fn truncate_front(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let mut out = String::new();
    for _ in 0..max_chars {
        let Some(ch) = chars.next() else {
            return out;
        };
        out.push(ch);
    }
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    text.chars().skip(count - max_chars).collect()
}

fn push_tail(buffer: &mut String, addition: &str, max_chars: usize) {
    if addition.is_empty() {
        return;
    }
    buffer.push_str(addition);
    let count = buffer.chars().count();
    if count > max_chars {
        *buffer = buffer.chars().skip(count - max_chars).collect();
    }
}

fn output_preview(text: &str) -> Option<String> {
    let compact = clean_text(text)?;
    if compact.chars().count() <= TOOL_OUTPUT_MAX_CHARS {
        Some(compact)
    } else {
        Some(format!("…{}", tail_chars(&compact, TOOL_OUTPUT_MAX_CHARS)))
    }
}

fn string_value(value: &Value) -> Option<String> {
    value.as_str().and_then(clean_text)
}

fn status_is_start(status: &str) -> bool {
    matches!(status, "pending" | "in_progress" | "inprogress" | "running")
}

fn status_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "canceled")
}

fn normalize_status(status: &str) -> String {
    status.trim().to_ascii_lowercase().replace('-', "_")
}

#[derive(Clone, Default)]
struct ToolActivityState {
    title: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    detail: Option<String>,
    status: Option<String>,
    output: String,
    announced_start: bool,
    terminal_emitted: bool,
    last_progress: Option<String>,
}

pub struct ToolActivityTracker {
    states: HashMap<String, ToolActivityState>,
}

impl ToolActivityTracker {
    pub fn new() -> Self {
        Self { states: HashMap::new() }
    }

    fn state_mut(&mut self, id: &str) -> &mut ToolActivityState {
        self.states.entry(id.to_string()).or_default()
    }

    pub fn note_acp_content_chunk(&mut self, update: &Value) {
        let Some(id) = update.get("toolCallId").and_then(|v| v.as_str()) else {
            return;
        };
        let Some(content) = update.get("content") else {
            return;
        };
        let texts = tool_content_texts(content);
        let detail = tool_content_diff_detail(content);
        let state = self.state_mut(id);
        if let Some(detail) = detail {
            if state.detail.is_none() {
                state.detail = Some(detail);
            }
        }
        for text in texts {
            push_tail(&mut state.output, &text, TOOL_OUTPUT_MAX_CHARS * 2);
        }
    }

    pub fn acp_tool_line(&mut self, backend_label: &str, update: &Value) -> Option<String> {
        let id = update
            .get("toolCallId")
            .or_else(|| update.get("title"))
            .or_else(|| update.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("tool");
        let state = self.state_mut(id);

        apply_patch_string(update, "title", &mut state.title);
        apply_patch_string(update, "name", &mut state.name);
        apply_patch_string(update, "kind", &mut state.kind);
        apply_patch_string(update, "status", &mut state.status);

        if let Some(raw_input) = update.get("rawInput") {
            if raw_input.is_null() {
                state.detail = None;
            } else if let Some(detail) = raw_input_detail(raw_input) {
                state.detail = Some(detail);
            }
        }
        if let Some(locations) = update.get("locations") {
            if locations.is_null() {
                if update.get("rawInput").is_none() {
                    state.detail = None;
                }
            } else if state.detail.is_none() {
                state.detail = locations_detail(locations);
            }
        }
        if let Some(content) = update.get("content") {
            if content.is_null() || content.as_array().map(|entries| entries.is_empty()).unwrap_or(false) {
                state.output.clear();
            } else {
                let texts = tool_content_texts(content);
                state.output.clear();
                for text in texts {
                    push_tail(&mut state.output, &text, TOOL_OUTPUT_MAX_CHARS * 2);
                }
                if state.detail.is_none() {
                    state.detail = tool_content_diff_detail(content);
                }
            }
        }
        if update.get("content").is_none() {
            if let Some(raw_output) = update.get("rawOutput") {
                if raw_output.is_null() {
                    state.output.clear();
                } else if let Some(output) = json_output_text(raw_output) {
                    state.output = tail_chars(&output, TOOL_OUTPUT_MAX_CHARS * 2);
                }
            }
        }

        let status = state
            .status
            .as_deref()
            .map(normalize_status)
            .unwrap_or_else(|| "running".to_string());
        if status_is_start(&status) {
            if state.announced_start {
                return None;
            }
            state.announced_start = true;
            return Some(format_activity_line(backend_label, state, false));
        }
        if status_is_terminal(&status) {
            if state.terminal_emitted {
                return None;
            }
            state.terminal_emitted = true;
            return Some(format_activity_line(backend_label, state, true));
        }
        None
    }

    pub fn note_codex_output(&mut self, item_id: &str, output: &str) {
        if item_id.is_empty() || output.is_empty() {
            return;
        }
        let state = self.state_mut(item_id);
        push_tail(&mut state.output, output, TOOL_OUTPUT_MAX_CHARS * 2);
    }

    pub fn codex_progress_line(&mut self, backend_label: &str, item_id: &str, message: &str) -> Option<String> {
        let message = clean_text(message).map(|m| truncate_front(&m, TOOL_PROGRESS_MAX_CHARS))?;
        let state = self.state_mut(item_id);
        if state.last_progress.as_deref() == Some(message.as_str()) {
            return None;
        }
        state.last_progress = Some(message.clone());
        Some(format!("\n[{backend_label} tool progress] {message}\n"))
    }

    pub fn codex_tool_line(&mut self, backend_label: &str, item: &Value, started: bool) -> Option<String> {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("tool");
        let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or(item_type);
        let state = self.state_mut(item_id);
        state.title = Some(codex_tool_title(item));
        if state.detail.is_none() {
            state.detail = codex_tool_detail(item);
        }
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .map(normalize_status)
            .unwrap_or_else(|| if started { "in_progress".to_string() } else { "completed".to_string() });
        state.status = Some(status.clone());

        if !started {
            if let Some(output) = codex_tool_output(item) {
                state.output = tail_chars(&output, TOOL_OUTPUT_MAX_CHARS * 2);
            }
        }

        if status_is_start(&status) {
            if state.announced_start {
                return None;
            }
            state.announced_start = true;
            return Some(format_activity_line(backend_label, state, false));
        }
        if status_is_terminal(&status) {
            if state.terminal_emitted {
                return None;
            }
            state.terminal_emitted = true;
            return Some(format_activity_line(backend_label, state, true));
        }
        None
    }
}

fn apply_patch_string(update: &Value, key: &str, target: &mut Option<String>) {
    let Some(value) = update.get(key) else {
        return;
    };
    if value.is_null() {
        *target = None;
    } else if let Some(text) = string_value(value) {
        *target = Some(text);
    }
}

fn raw_input_detail(raw_input: &Value) -> Option<String> {
    if let Some(text) = string_value(raw_input) {
        return Some(truncate_front(&text, TOOL_DETAIL_MAX_CHARS));
    }
    let object = raw_input.as_object()?;
    for key in ["command", "cmd", "path", "file_path", "filePath", "query", "url"] {
        if let Some(value) = object.get(key) {
            if let Some(text) = string_value(value) {
                return Some(truncate_front(&text, TOOL_DETAIL_MAX_CHARS));
            }
            if let Some(parts) = value.as_array() {
                let joined = parts
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                if let Some(text) = clean_text(&joined) {
                    return Some(truncate_front(&text, TOOL_DETAIL_MAX_CHARS));
                }
            }
        }
    }
    None
}

fn locations_detail(locations: &Value) -> Option<String> {
    let paths = locations
        .as_array()?
        .iter()
        .filter_map(|entry| entry.get("path").and_then(|v| v.as_str()))
        .take(3)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        None
    } else {
        Some(truncate_front(&paths.join(", "), TOOL_DETAIL_MAX_CHARS))
    }
}

fn tool_content_entries(content: &Value) -> Vec<&Value> {
    if let Some(entries) = content.as_array() {
        entries.iter().collect()
    } else {
        vec![content]
    }
}

fn tool_content_texts(content: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for entry in tool_content_entries(content) {
        match entry.get("type").and_then(|v| v.as_str()) {
            Some("content") => {
                let inner = entry.get("content").unwrap_or(&Value::Null);
                if let Some(text) = inner.get("text").and_then(|v| v.as_str()) {
                    out.push(text.to_string());
                } else if let Some(text) = inner
                    .get("resource")
                    .and_then(|r| r.get("text"))
                    .and_then(|v| v.as_str())
                {
                    out.push(text.to_string());
                }
            }
            _ => {
                if let Some(text) = entry.get("text").and_then(|v| v.as_str()) {
                    out.push(text.to_string());
                }
            }
        }
    }
    out
}

fn tool_content_diff_detail(content: &Value) -> Option<String> {
    let mut paths = Vec::new();
    for entry in tool_content_entries(content) {
        if entry.get("type").and_then(|v| v.as_str()) != Some("diff") {
            continue;
        }
        if let Some(path) = entry.get("path").and_then(|v| v.as_str()) {
            paths.push(path.to_string());
        }
        if let Some(changes) = entry.get("changes").and_then(|v| v.as_array()) {
            for change in changes {
                if let Some(path) = change.get("path").and_then(|v| v.as_str()) {
                    paths.push(path.to_string());
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        None
    } else {
        Some(truncate_front(&paths.into_iter().take(3).collect::<Vec<_>>().join(", "), TOOL_DETAIL_MAX_CHARS))
    }
}

fn json_output_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => clean_text(text),
        Value::Object(object) => {
            for key in ["output", "text", "message", "error"] {
                if let Some(text) = object.get(key).and_then(|v| v.as_str()).and_then(clean_text) {
                    return Some(text);
                }
            }
            if let Some(content) = object.get("content").and_then(|v| v.as_array()) {
                let texts = content
                    .iter()
                    .filter_map(|entry| entry.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Some(text) = clean_text(&texts) {
                    return Some(text);
                }
            }
            serde_json::to_string(value).ok().and_then(|s| clean_text(&s))
        }
        Value::Array(_) | Value::Number(_) | Value::Bool(_) => serde_json::to_string(value).ok().and_then(|s| clean_text(&s)),
        Value::Null => None,
    }
}

fn format_activity_line(backend_label: &str, state: &ToolActivityState, terminal: bool) -> String {
    let title = state
        .title
        .clone()
        .or_else(|| state.name.clone())
        .or_else(|| state.kind.clone())
        .unwrap_or_else(|| "tool".to_string());
    let detail = state
        .detail
        .as_ref()
        .filter(|detail| !detail.is_empty() && !title.contains(detail.as_str()))
        .map(|detail| format!(" — {detail}"))
        .unwrap_or_default();
    if terminal {
        let status = state.status.clone().unwrap_or_else(|| "completed".to_string());
        let output = output_preview(&state.output)
            .map(|preview| format!("\n  output: {preview}"))
            .unwrap_or_default();
        format!("\n[{backend_label} tool {status}] {title}{detail}{output}\n")
    } else {
        format!("\n[{backend_label} tool] {title}{detail}...\n")
    }
}

fn codex_tool_title(item: &Value) -> String {
    let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("tool");
    match kind {
        "commandExecution" => item
            .get("command")
            .and_then(|v| v.as_str())
            .and_then(clean_text)
            .map(|c| format!("Run {}", truncate_front(&c, 80)))
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
            .and_then(clean_text)
            .map(|q| format!("Web search: {}", truncate_front(&q, 60)))
            .unwrap_or_else(|| "Web search".to_string()),
        "dynamicToolCall" => {
            let namespace = item.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("Tool call");
            if namespace.is_empty() {
                tool.to_string()
            } else {
                format!("{namespace}.{tool}")
            }
        }
        other => other.to_string(),
    }
}

fn codex_tool_detail(item: &Value) -> Option<String> {
    if item.get("type").and_then(|v| v.as_str()) != Some("fileChange") {
        return None;
    }
    let paths = item
        .get("changes")
        .and_then(|v| v.as_array())?
        .iter()
        .filter_map(|change| change.get("path").and_then(|v| v.as_str()))
        .take(3)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        None
    } else {
        Some(truncate_front(&paths.join(", "), TOOL_DETAIL_MAX_CHARS))
    }
}

fn codex_tool_output(item: &Value) -> Option<String> {
    match item.get("type").and_then(|v| v.as_str()) {
        Some("commandExecution") => item
            .get("aggregatedOutput")
            .and_then(|v| v.as_str())
            .and_then(clean_text),
        Some("mcpToolCall") => {
            if let Some(error) = item.get("error") {
                if let Some(message) = error.get("message").and_then(|v| v.as_str()).and_then(clean_text) {
                    return Some(message);
                }
            }
            item.get("result").and_then(json_output_text)
        }
        Some("dynamicToolCall") => item
            .get("contentItems")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| entry.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .and_then(|text| clean_text(&text)),
        _ => None,
    }
}

pub struct PlanActivityTracker {
    fingerprints: HashMap<String, String>,
}

impl PlanActivityTracker {
    pub fn new() -> Self {
        Self { fingerprints: HashMap::new() }
    }

    pub fn acp_plan_line(&mut self, backend_label: &str, update: &Value) -> Option<String> {
        let kind = update.get("sessionUpdate").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "plan_removed" {
            let plan_id = update.get("planId").and_then(|v| v.as_str()).unwrap_or("plan").to_string();
            let fingerprint = format!("removed:{plan_id}");
            if self.fingerprints.get(&plan_id) == Some(&fingerprint) {
                return None;
            }
            self.fingerprints.insert(plan_id, fingerprint);
            return Some(format!("\n[{backend_label} plan] plan removed\n"));
        }

        let legacy_plan = if kind == "plan" {
            Some(json!({
                "type": "items",
                "planId": "legacy",
                "entries": update.get("entries").cloned().unwrap_or_else(|| json!([]))
            }))
        } else {
            None
        };
        let plan = legacy_plan.as_ref().or_else(|| update.get("plan"))?;
        let plan_id = plan.get("planId").and_then(|v| v.as_str()).unwrap_or("plan").to_string();
        let fingerprint = serde_json::to_string(plan).unwrap_or_default();
        if self.fingerprints.get(&plan_id) == Some(&fingerprint) {
            return None;
        }
        self.fingerprints.insert(plan_id, fingerprint);

        let summary = match plan.get("type").and_then(|v| v.as_str()) {
            Some("items") => {
                let entries = plan.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let total = entries.len();
                let done = entries
                    .iter()
                    .filter(|entry| {
                        entry
                            .get("status")
                            .and_then(|v| v.as_str())
                            .map(|s| matches!(s, "completed" | "cancelled" | "canceled"))
                            .unwrap_or(false)
                    })
                    .count();
                let current = entries
                    .iter()
                    .find(|entry| entry.get("status").and_then(|v| v.as_str()) == Some("in_progress"))
                    .or_else(|| entries.iter().find(|entry| entry.get("status").and_then(|v| v.as_str()) == Some("pending")))
                    .and_then(|entry| entry.get("content").and_then(|v| v.as_str()))
                    .and_then(|text| clean_text(text));
                if total == 0 {
                    "plan updated".to_string()
                } else if let Some(current) = current {
                    format!("{done}/{total} completed — {}", truncate_front(&current, 120))
                } else {
                    format!("{done}/{total} completed")
                }
            }
            Some("markdown") => plan
                .get("content")
                .and_then(|v| v.as_str())
                .and_then(|content| content.lines().find(|line| !line.trim().is_empty()))
                .map(|line| clean_text(line.trim_start_matches('#')).unwrap_or_else(|| "plan updated".to_string()))
                .map(|line| truncate_front(&line, 160))
                .unwrap_or_else(|| "plan updated".to_string()),
            Some("file") => plan
                .get("uri")
                .and_then(|v| v.as_str())
                .map(|uri| format!("plan file: {}", truncate_front(uri, 140)))
                .unwrap_or_else(|| "plan updated".to_string()),
            _ => "plan updated".to_string(),
        };
        Some(format!("\n[{backend_label} plan] {summary}\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acp_tool_patch_keeps_title_and_includes_output_tail() {
        let mut tracker = ToolActivityTracker::new();
        let start = json!({
            "toolCallId": "t1",
            "title": "Run tests",
            "status": "in_progress",
            "rawInput": { "command": "npm test" }
        });
        let line = tracker.acp_tool_line("ACP", &start).expect("start line");
        assert!(line.contains("[ACP tool] Run tests — npm test..."), "{line}");

        tracker.note_acp_content_chunk(&json!({
            "toolCallId": "t1",
            "content": { "type": "content", "content": { "type": "text", "text": "first output\n" } }
        }));
        tracker.note_acp_content_chunk(&json!({
            "toolCallId": "t1",
            "content": { "type": "content", "content": { "type": "text", "text": "second output" } }
        }));
        let done = tracker
            .acp_tool_line("ACP", &json!({ "toolCallId": "t1", "status": "completed" }))
            .expect("completion line");
        assert!(done.contains("[ACP tool completed] Run tests"), "{done}");
        assert!(done.contains("first output second output"), "{done}");
    }

    #[test]
    fn acp_diff_locations_become_tool_detail() {
        let mut tracker = ToolActivityTracker::new();
        let line = tracker
            .acp_tool_line(
                "ACP",
                &json!({
                    "toolCallId": "edit-1",
                    "title": "Edit",
                    "status": "completed",
                    "content": [{ "type": "diff", "path": "/tmp/a.rs", "newText": "x" }]
                }),
            )
            .expect("line");
        assert!(line.contains("Edit — /tmp/a.rs"), "{line}");
    }

    #[test]
    fn codex_output_delta_is_reported_on_completion() {
        let mut tracker = ToolActivityTracker::new();
        tracker.note_codex_output("cmd1", "build ok\n");
        let item = json!({
            "id": "cmd1",
            "type": "commandExecution",
            "command": "cargo test",
            "status": "completed",
            "aggregatedOutput": "final output"
        });
        let line = tracker.codex_tool_line("Codex", &item, false).expect("line");
        assert!(line.contains("Run cargo test"), "{line}");
        assert!(line.contains("final output"), "{line}");
    }

    #[test]
    fn repeated_plan_snapshots_are_not_reemitted() {
        let mut tracker = PlanActivityTracker::new();
        let update = json!({
            "plan": {
                "type": "items",
                "planId": "p1",
                "entries": [
                    { "content": "inspect", "status": "completed", "priority": "high" },
                    { "content": "implement", "status": "in_progress", "priority": "high" }
                ]
            }
        });
        let first = tracker.acp_plan_line("ACP", &update).expect("first plan line");
        assert!(first.contains("1/2 completed"), "{first}");
        assert!(tracker.acp_plan_line("ACP", &update).is_none());

        let legacy = json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "inspect", "status": "completed", "priority": "high" },
                { "content": "implement", "status": "in_progress", "priority": "high" }
            ]
        });
        let legacy_line = tracker.acp_plan_line("ACP", &legacy).expect("legacy plan line");
        assert!(legacy_line.contains("1/2 completed"), "{legacy_line}");
        let removed = tracker
            .acp_plan_line("ACP", &json!({ "sessionUpdate": "plan_removed", "planId": "p1" }))
            .expect("plan removal line");
        assert!(removed.contains("plan removed"), "{removed}");
    }
}
