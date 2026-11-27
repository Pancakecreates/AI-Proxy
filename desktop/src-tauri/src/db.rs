use crate::types::{
    AppLogEntry, AppSettings, ChatMessageRecord, ChatSummary, RequestLogEntry, UsageBucket,
    UsageSummary,
};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub struct AppDb {
    conn: Mutex<Connection>,
}

impl AppDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                request_id TEXT NOT NULL,
                protocol TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                model TEXT NOT NULL,
                resolved_model TEXT,
                effort TEXT,
                backend_key TEXT,
                account_label TEXT,
                status INTEGER NOT NULL,
                latency_ms INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                thinking_tokens INTEGER NOT NULL,
                usage_source TEXT NOT NULL,
                cost_usd REAL NOT NULL,
                api_equivalent_usd REAL NOT NULL,
                error TEXT,
                prompt_preview TEXT,
                response_preview TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model);

            CREATE TABLE IF NOT EXISTS app_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                level TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_app_logs_id ON app_logs(id DESC);

            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                model_id TEXT NOT NULL,
                protocol TEXT NOT NULL,
                effort TEXT NOT NULL,
                system_prompt TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                thinking TEXT NOT NULL,
                model_id TEXT,
                effort TEXT,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                latency_ms INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                usage_source TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id, created_at ASC);
            ",
        )
        .map_err(|e| e.to_string())?;

        let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN effort TEXT", []);
        let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN account_label TEXT", []);

        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn load_settings(&self) -> Result<Option<AppSettings>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = 'app_settings'")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let json_str: String = row.get(0).map_err(|e| e.to_string())?;
            match serde_json::from_str::<AppSettings>(&json_str) {
                Ok(parsed) => return Ok(Some(parsed)),
                Err(err) => {
                    // Recover critical fields (such as apiKey) if an older/newer payload fails strict parsing
                    let mut recovered = AppSettings::default();
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        if let Some(k) = val.get("apiKey").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                            recovered.api_key = Some(k.to_string());
                        }
                        if let Some(h) = val.get("host").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                            recovered.host = h.to_string();
                        }
                        if let Some(p) = val.get("anthropicPort").and_then(|v| v.as_u64()) {
                            recovered.anthropic_port = p as u16;
                        }
                        if let Some(p) = val.get("openaiPort").and_then(|v| v.as_u64()) {
                            recovered.openai_port = p as u16;
                        }
                    }
                    eprintln!("Warning: partial settings recovery after parse error: {err}");
                    return Ok(Some(recovered));
                }
            }
        }
        Ok(None)
    }

    pub fn load_persisted_api_key(&self) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = 'api_key'")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let val: String = row.get(0).map_err(|e| e.to_string())?;
            let trimmed = val.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(Some(trimmed));
            }
        }
        Ok(None)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let json_str = serde_json::to_string(settings).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app_settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json_str],
        )
        .map_err(|e| e.to_string())?;
        if let Some(key) = settings.api_key.as_deref().map(|k| k.trim()).filter(|k| !k.is_empty()) {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('api_key', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn insert_request_log(&self, entry: &RequestLogEntry) -> Result<RequestLogEntry, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO request_logs (
                created_at, request_id, protocol, method, path, model, resolved_model, effort,
                backend_key, account_label, status, latency_ms, input_tokens, output_tokens, thinking_tokens,
                usage_source, cost_usd, api_equivalent_usd, error, prompt_preview, response_preview
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                entry.created_at,
                entry.request_id,
                entry.protocol,
                entry.method,
                entry.path,
                entry.model,
                entry.resolved_model,
                entry.effort,
                entry.backend_key,
                entry.account_label,
                entry.status as i64,
                entry.latency_ms as i64,
                entry.input_tokens as i64,
                entry.output_tokens as i64,
                entry.thinking_tokens as i64,
                entry.usage_source,
                entry.cost_usd,
                entry.api_equivalent_usd,
                entry.error,
                entry.prompt_preview,
                entry.response_preview,
            ],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        let mut out = entry.clone();
        out.id = id;
        Ok(out)
    }

    pub fn query_request_logs(&self, limit: usize, search: Option<&str>) -> Result<Vec<RequestLogEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let limit_i64 = limit.clamp(1, 500) as i64;
        let q = search.map(|s| format!("%{}%", s.trim().to_lowercase())).filter(|s| s != "%%");

        let sql = if q.is_some() {
            "SELECT id, created_at, request_id, protocol, method, path, model, resolved_model, effort,
                    backend_key, account_label, status, latency_ms, input_tokens, output_tokens, thinking_tokens,
                    usage_source, cost_usd, api_equivalent_usd, error, prompt_preview, response_preview
             FROM request_logs
             WHERE lower(model) LIKE ?1 OR lower(coalesce(resolved_model,'')) LIKE ?1
                OR lower(coalesce(backend_key,'')) LIKE ?1 OR lower(coalesce(account_label,'')) LIKE ?1
                OR lower(coalesce(error,'')) LIKE ?1
                OR lower(coalesce(prompt_preview,'')) LIKE ?1 OR lower(coalesce(effort,'')) LIKE ?1
             ORDER BY id DESC LIMIT ?2"
        } else {
            "SELECT id, created_at, request_id, protocol, method, path, model, resolved_model, effort,
                    backend_key, account_label, status, latency_ms, input_tokens, output_tokens, thinking_tokens,
                    usage_source, cost_usd, api_equivalent_usd, error, prompt_preview, response_preview
             FROM request_logs
             ORDER BY id DESC LIMIT ?1"
        };

        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<RequestLogEntry> {
            Ok(RequestLogEntry {
                id: row.get(0)?,
                created_at: row.get(1)?,
                request_id: row.get(2)?,
                protocol: row.get(3)?,
                method: row.get(4)?,
                path: row.get(5)?,
                model: row.get(6)?,
                resolved_model: row.get(7)?,
                effort: row.get(8)?,
                backend_key: row.get(9)?,
                account_label: row.get(10)?,
                status: row.get::<_, i64>(11)? as u16,
                latency_ms: row.get::<_, i64>(12)? as u64,
                input_tokens: row.get::<_, i64>(13)? as u64,
                output_tokens: row.get::<_, i64>(14)? as u64,
                thinking_tokens: row.get::<_, i64>(15)? as u64,
                usage_source: row.get(16)?,
                cost_usd: row.get(17)?,
                api_equivalent_usd: row.get(18)?,
                error: row.get(19)?,
                prompt_preview: row.get(20)?,
                response_preview: row.get(21)?,
            })
        };

        let mut out = Vec::new();
        if let Some(pattern) = q {
            let rows = stmt.query_map(params![pattern, limit_i64], map_row).map_err(|e| e.to_string())?;
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
        } else {
            let rows = stmt.query_map(params![limit_i64], map_row).map_err(|e| e.to_string())?;
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
        }
        Ok(out)
    }

    pub fn insert_app_log(&self, level: &str, source: &str, message: &str) -> Result<AppLogEntry, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let created_at = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO app_logs (created_at, level, source, message) VALUES (?1, ?2, ?3, ?4)",
            params![created_at, level, source, message],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        let _ = conn.execute(
            "DELETE FROM app_logs WHERE id <= (SELECT coalesce(max(id), 0) - 5000 FROM app_logs)",
            [],
        );
        Ok(AppLogEntry {
            id,
            created_at,
            level: level.to_string(),
            source: source.to_string(),
            message: message.to_string(),
        })
    }

    pub fn query_app_logs(&self, limit: usize, level: Option<&str>) -> Result<Vec<AppLogEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let limit_i64 = limit.clamp(1, 1000) as i64;
        let lvl = level.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty() && s != "all");

        let mut out = Vec::new();
        if let Some(l) = lvl {
            let mut stmt = conn
                .prepare("SELECT id, created_at, level, source, message FROM app_logs WHERE lower(level) = ?1 ORDER BY id DESC LIMIT ?2")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![l, limit_i64], |r| {
                    Ok(AppLogEntry {
                        id: r.get(0)?,
                        created_at: r.get(1)?,
                        level: r.get(2)?,
                        source: r.get(3)?,
                        message: r.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
        } else {
            let mut stmt = conn
                .prepare("SELECT id, created_at, level, source, message FROM app_logs ORDER BY id DESC LIMIT ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit_i64], |r| {
                    Ok(AppLogEntry {
                        id: r.get(0)?,
                        created_at: r.get(1)?,
                        level: r.get(2)?,
                        source: r.get(3)?,
                        message: r.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
        }
        Ok(out)
    }

    pub fn clear_logs(&self, kind: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if kind == "requests" || kind == "all" {
            conn.execute("DELETE FROM request_logs", []).map_err(|e| e.to_string())?;
        }
        if kind == "app" || kind == "all" {
            conn.execute("DELETE FROM app_logs", []).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_usage_summary(&self, days: i64) -> Result<UsageSummary, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let cutoff = (Utc::now() - chrono::Duration::days(days.max(1))).to_rfc3339();
        let mut stmt = conn
            .prepare(
                "SELECT created_at, coalesce(resolved_model, model), coalesce(backend_key, 'unknown'),
                        status, latency_ms, input_tokens, output_tokens, thinking_tokens,
                        usage_source, cost_usd, api_equivalent_usd
                 FROM request_logs
                 WHERE created_at >= ?1
                 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let mut summary = UsageSummary {
            total_requests: 0,
            success_requests: 0,
            error_requests: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_thinking_tokens: 0,
            total_cost_usd: 0.0,
            total_api_equivalent_usd: 0.0,
            measured_count: 0,
            estimated_count: 0,
            avg_latency_ms: 0.0,
            by_day: Vec::new(),
            by_backend: Vec::new(),
            by_model: Vec::new(),
        };

        let mut total_latency = 0u64;
        let mut day_map: HashMap<String, UsageBucket> = HashMap::new();
        let mut backend_map: HashMap<String, UsageBucket> = HashMap::new();
        let mut model_map: HashMap<String, UsageBucket> = HashMap::new();

        let rows = stmt
            .query_map(params![cutoff], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)? as u64,
                    r.get::<_, i64>(5)? as u64,
                    r.get::<_, i64>(6)? as u64,
                    r.get::<_, i64>(7)? as u64,
                    r.get::<_, String>(8)?,
                    r.get::<_, f64>(9)?,
                    r.get::<_, f64>(10)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            let (created_at, model, backend, status, latency, in_tok, out_tok, think_tok, src, cost, eq_cost) =
                row.map_err(|e| e.to_string())?;
            summary.total_requests += 1;
            if (200..400).contains(&status) {
                summary.success_requests += 1;
            } else {
                summary.error_requests += 1;
            }
            summary.total_input_tokens += in_tok;
            summary.total_output_tokens += out_tok;
            summary.total_thinking_tokens += think_tok;
            summary.total_cost_usd += cost;
            summary.total_api_equivalent_usd += eq_cost;
            total_latency += latency;
            if src == "measured" {
                summary.measured_count += 1;
            } else {
                summary.estimated_count += 1;
            }

            let day = created_at.get(0..10).unwrap_or("unknown").to_string();
            for (map, key, label) in [
                (&mut day_map, day.clone(), day),
                (&mut backend_map, backend.clone(), backend),
                (&mut model_map, model.clone(), model),
            ] {
                let b = map.entry(key.clone()).or_insert_with(|| UsageBucket {
                    key,
                    label,
                    requests: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: 0.0,
                    api_equivalent_usd: 0.0,
                });
                b.requests += 1;
                b.input_tokens += in_tok;
                b.output_tokens += out_tok;
                b.cost_usd += cost;
                b.api_equivalent_usd += eq_cost;
            }
        }

        if summary.total_requests > 0 {
            summary.avg_latency_ms = total_latency as f64 / summary.total_requests as f64;
        }

        let mut by_day: Vec<UsageBucket> = day_map.into_values().collect();
        by_day.sort_by(|a, b| a.key.cmp(&b.key));
        let mut by_backend: Vec<UsageBucket> = backend_map.into_values().collect();
        by_backend.sort_by(|a, b| {
            (b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens))
        });
        let mut by_model: Vec<UsageBucket> = model_map.into_values().collect();
        by_model.sort_by(|a, b| {
            (b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens))
        });
        by_model.truncate(25);

        summary.by_day = by_day;
        summary.by_backend = by_backend;
        summary.by_model = by_model;
        Ok(summary)
    }

    pub fn list_chats(&self) -> Result<Vec<ChatSummary>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.title, c.model_id, c.protocol, c.effort, c.system_prompt,
                        c.created_at, c.updated_at,
                        (SELECT count(*) FROM chat_messages m WHERE m.chat_id = c.id) AS msg_count
                 FROM chats c
                 ORDER BY c.updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ChatSummary {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    model_id: r.get(2)?,
                    protocol: r.get(3)?,
                    effort: r.get(4)?,
                    system_prompt: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                    message_count: r.get::<_, i64>(8)? as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn create_chat(&self, chat: &ChatSummary) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO chats (id, title, model_id, protocol, effort, system_prompt, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                chat.id,
                chat.title,
                chat.model_id,
                chat.protocol,
                chat.effort,
                chat.system_prompt,
                chat.created_at,
                chat.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_chat_meta(
        &self,
        chat_id: &str,
        title: Option<&str>,
        model_id: Option<&str>,
        protocol: Option<&str>,
        effort: Option<&str>,
        system_prompt: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        if let Some(t) = title {
            conn.execute("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3", params![t, now, chat_id])
                .map_err(|e| e.to_string())?;
        }
        if let Some(m) = model_id {
            conn.execute("UPDATE chats SET model_id = ?1, updated_at = ?2 WHERE id = ?3", params![m, now, chat_id])
                .map_err(|e| e.to_string())?;
        }
        if let Some(p) = protocol {
            conn.execute("UPDATE chats SET protocol = ?1, updated_at = ?2 WHERE id = ?3", params![p, now, chat_id])
                .map_err(|e| e.to_string())?;
        }
        if let Some(e) = effort {
            conn.execute("UPDATE chats SET effort = ?1, updated_at = ?2 WHERE id = ?3", params![e, now, chat_id])
                .map_err(|e| e.to_string())?;
        }
        if let Some(sp) = system_prompt {
            conn.execute("UPDATE chats SET system_prompt = ?1, updated_at = ?2 WHERE id = ?3", params![sp, now, chat_id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn delete_chat(&self, chat_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM chat_messages WHERE chat_id = ?1", params![chat_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM chats WHERE id = ?1", params![chat_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_chat_messages(&self, chat_id: &str) -> Result<Vec<ChatMessageRecord>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, chat_id, role, content, thinking, model_id, effort,
                        input_tokens, output_tokens, latency_ms, cost_usd, usage_source, created_at
                 FROM chat_messages
                 WHERE chat_id = ?1
                 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![chat_id], |r| {
                Ok(ChatMessageRecord {
                    id: r.get(0)?,
                    chat_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    thinking: r.get(4)?,
                    model_id: r.get(5)?,
                    effort: r.get(6)?,
                    input_tokens: r.get::<_, i64>(7)? as u64,
                    output_tokens: r.get::<_, i64>(8)? as u64,
                    latency_ms: r.get::<_, i64>(9)? as u64,
                    cost_usd: r.get(10)?,
                    usage_source: r.get(11)?,
                    created_at: r.get(12)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn insert_chat_message(&self, msg: &ChatMessageRecord) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO chat_messages (
                id, chat_id, role, content, thinking, model_id, effort,
                input_tokens, output_tokens, latency_ms, cost_usd, usage_source, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                msg.id,
                msg.chat_id,
                msg.role,
                msg.content,
                msg.thinking,
                msg.model_id,
                msg.effort,
                msg.input_tokens as i64,
                msg.output_tokens as i64,
                msg.latency_ms as i64,
                msg.cost_usd,
                msg.usage_source,
                msg.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
            params![msg.created_at, msg.chat_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_preserve_api_key_across_partial_or_legacy_json() {
        let dir = std::env::temp_dir().join(format!("ai_proxy_db_test_{}", uuid::Uuid::new_v4()));
        let db = AppDb::open(&dir.join("proxy.db")).unwrap();

        let mut s = AppSettings::default();
        s.api_key = Some("aipx_persistent_test_token_123456".to_string());
        db.save_settings(&s).unwrap();

        assert_eq!(
            db.load_persisted_api_key().unwrap().as_deref(),
            Some("aipx_persistent_test_token_123456")
        );

        // Simulate legacy JSON missing newer fields
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
                params![r#"{"host":"127.0.0.1","anthropicPort":9001,"apiKey":"aipx_persistent_test_token_123456"}"#],
            )
            .unwrap();
        }

        let loaded = db.load_settings().unwrap().unwrap();
        assert_eq!(loaded.anthropic_port, 9001);
        assert_eq!(
            loaded.api_key.as_deref(),
            Some("aipx_persistent_test_token_123456")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
