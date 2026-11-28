use crate::discovery::{read_antigravity_account_email, resolve_runtime_executable};
use crate::types::{AccountQuotaReport, AntigravityAccountConfig, AppSettings, QuotaWindowInfo};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const CODE_ASSIST_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal";
const DAILY_CODE_ASSIST_URL: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal";

fn antigravity_user_agent() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "amd64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86"
    };
    format!("antigravity/hub/2.24.0 (aidev_client; os_type={os}; arch={arch}; cl=963137146)")
}

fn spawn_hidden_cmd(exe: &str, args: &[String], envs: &[(&str, &str)]) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd
}

pub async fn fetch_antigravity_quota(account: &AntigravityAccountConfig, proxy: Option<&str>) -> AccountQuotaReport {
    let now = Utc::now().to_rfc3339();
    let app_data_path = Path::new(&account.gemini_dir).join(&account.app_data_dir);
    let token_file = app_data_path.join("antigravity-oauth-token");
    let email = read_antigravity_account_email(&app_data_path).or_else(|| account.email.clone());

    let mut report = AccountQuotaReport {
        account_key: format!("antigravity:{}", account.id),
        provider: "antigravity".to_string(),
        label: account.label.clone(),
        email,
        signed_in: false,
        windows: Vec::new(),
        error: None,
        verification_url: None,
        checked_at: now,
    };

    let Ok(raw) = tokio::fs::read_to_string(&token_file).await else {
        report.error = Some("Токен входа не найден".to_string());
        return report;
    };
    let Ok(parsed): Result<Value, _> = serde_json::from_str(&raw) else {
        report.error = Some("Повреждённый файл токена".to_string());
        return report;
    };
    let Some(access_token) = parsed
        .get("token")
        .and_then(|t| t.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        report.error = Some("Требуется повторный вход".to_string());
        return report;
    };

    report.signed_in = true;

    let client = match crate::net::build_client(
        proxy.as_deref(),
        Some(std::time::Duration::from_secs(10)),
    ) {
        Ok(c) => c,
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    };

    let ua = antigravity_user_agent();
    let load_res = client
        .post(format!("{CODE_ASSIST_URL}:loadCodeAssist"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", &ua)
        .json(&json!({}))
        .send()
        .await;

    let load_json: Value = match load_res {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
        Ok(r) => {
            report.error = Some(format!("HTTP {} от Code Assist (токен может требовать обновления через чат)", r.status()));
            return report;
        }
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    };

    if let Some(tiers) = load_json.get("ineligibleTiers").and_then(|v| v.as_array()) {
        for tier in tiers {
            if tier.get("reasonCode").and_then(|v| v.as_str()) == Some("VALIDATION_REQUIRED") {
                if let Some(url) = tier.get("validationUrl").and_then(|v| v.as_str()) {
                    report.verification_url = Some(url.to_string());
                }
            }
        }
    }

    let Some(project) = load_json
        .get("cloudaicompanionProject")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
    else {
        return report;
    };

    let quota_res = client
        .post(format!("{DAILY_CODE_ASSIST_URL}:retrieveUserQuotaSummary"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", &ua)
        .json(&json!({ "project": project }))
        .send()
        .await;

    let quota_json: Value = match quota_res {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
        Ok(r) => {
            report.error = Some(format!("HTTP {} при чтении квоты", r.status()));
            return report;
        }
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    };

    if let Some(groups) = quota_json.get("groups").and_then(|v| v.as_array()) {
        for group in groups {
            let group_name = group
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("Quota")
                .to_string();
            let desc = group.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let models: Vec<String> = desc
                .strip_prefix("Models within this group:")
                .or_else(|| desc.strip_prefix("models within this group:"))
                .map(|rest| {
                    rest.trim_end_matches('.')
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();

            if let Some(buckets) = group.get("buckets").and_then(|v| v.as_array()) {
                for bucket in buckets {
                    let b_name = bucket
                        .get("displayName")
                        .or_else(|| bucket.get("window"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Window");
                    let rem_frac = bucket
                        .get("remainingFraction")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(1.0)
                        .clamp(0.0, 1.0);
                    let remaining_percent = (rem_frac * 1000.0).round() / 10.0;
                    let used_percent = ((1.0 - rem_frac) * 1000.0).round() / 10.0;
                    let resets_at = bucket
                        .get("resetTime")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    report.windows.push(QuotaWindowInfo {
                        label: format!("{group_name} · {b_name}"),
                        used_percent,
                        remaining_percent,
                        resets_at,
                        window_minutes: None,
                        models: models.clone(),
                    });
                }
            }
        }
    }

    report
}

pub async fn fetch_devin_plan(settings: &AppSettings) -> AccountQuotaReport {
    let now = Utc::now().to_rfc3339();
    let mut report = AccountQuotaReport {
        account_key: "devin".to_string(),
        provider: "devin".to_string(),
        label: "Devin".to_string(),
        email: None,
        signed_in: check_simple_auth_status(settings)
            .get("devin")
            .copied()
            .unwrap_or(false),
        windows: Vec::new(),
        error: None,
        verification_url: None,
        checked_at: now,
    };

    let Some(exe) = resolve_runtime_executable("devin", &["devin"], settings.devin_path.as_deref()) else {
        report.error = Some("Devin CLI не найден".to_string());
        return report;
    };

    let args = vec!["auth".to_string(), "status".to_string()];
    let mut cmd = spawn_hidden_cmd(&exe, &args, &[]);
    let output = match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => out,
        _ => {
            report.error = Some("Не удалось прочитать тариф Devin через CLI".to_string());
            return report;
        }
    };

    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut tier: Option<String> = None;
    let mut plan: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Tier:") {
            let value = value.trim();
            if !value.is_empty() {
                tier = Some(value.to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("Plan:") {
            let value = value.trim();
            if !value.is_empty() {
                plan = Some(value.to_string());
            }
        }
    }

    if let Some(value) = tier.or(plan) {
        report.signed_in = true;
        report.label = format!("Devin · {value}");
        report.error = Some("CLI не отдаёт остаток лимитов — показан только тариф аккаунта.".to_string());
    } else if report.signed_in {
        report.error = Some("CLI не отдаёт остаток лимитов.".to_string());
    }
    report
}

pub async fn fetch_codex_quota(settings: &AppSettings) -> AccountQuotaReport {
    let now = Utc::now().to_rfc3339();
    let mut report = AccountQuotaReport {
        account_key: "codex".to_string(),
        provider: "codex".to_string(),
        label: "Codex (ChatGPT)".to_string(),
        email: None,
        signed_in: false,
        windows: Vec::new(),
        error: None,
        verification_url: None,
        checked_at: now,
    };

    let Some(exe) = resolve_runtime_executable("codex", &["codex"], settings.codex_path.as_deref()) else {
        report.error = Some("codex CLI не найден".to_string());
        return report;
    };

    let args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    let mut cmd = spawn_hidden_cmd(&exe, &args, &[]);
    crate::net::apply_proxy_env(&mut cmd, settings.proxy_url.as_deref(), &std::collections::HashMap::new());
    let Ok(mut child) = cmd.spawn() else {
        report.error = Some("Не удалось запустить codex app-server".to_string());
        return report;
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return report;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return report;
    };
    let mut reader = BufReader::new(stdout).lines();

    async fn send_codex_rpc(stdin: &mut tokio::process::ChildStdin, id: u64, method: &str, params: Value) -> std::io::Result<()> {
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        stdin.write_all(line.as_bytes()).await
    }

    let res = tokio::time::timeout(std::time::Duration::from_secs(12), async {
        send_codex_rpc(
            &mut stdin,
            1,
            "initialize",
            json!({
                "clientInfo": { "name": "ai-proxy-desktop", "title": "AI Proxy", "version": "0.1.0" },
                "capabilities": { "experimentalApi": true }
            }),
        )
        .await
        .map_err(|e| e.to_string())?;

        // Wait id=1
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("id").and_then(|x| x.as_u64()) == Some(1) {
                    break;
                }
            }
        }

        send_codex_rpc(&mut stdin, 2, "account/read", json!({})).await.map_err(|e| e.to_string())?;
        send_codex_rpc(&mut stdin, 3, "account/rateLimits/read", json!({})).await.map_err(|e| e.to_string())?;

        let mut got_acc = false;
        let mut got_rl = false;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let id = v.get("id").and_then(|x| x.as_u64());
                if id == Some(2) {
                    got_acc = true;
                    if let Some(acc) = v.get("result").and_then(|r| r.get("account")) {
                        report.signed_in = true;
                        report.email = acc.get("email").and_then(|e| e.as_str()).map(|s| s.to_string());
                    }
                } else if id == Some(3) {
                    got_rl = true;
                    if let Some(rl) = v.get("result").and_then(|r| r.get("rateLimits")) {
                        for (w_key, w_label) in [("primary", "Окно 5 ч"), ("secondary", "Недельный лимит")] {
                            if let Some(win) = rl.get(w_key).filter(|x| !x.is_null()) {
                                let used = win.get("usedPercent").and_then(|x| x.as_f64()).unwrap_or(0.0);
                                let rem = (100.0 - used).clamp(0.0, 100.0);
                                let mins = win.get("windowDurationMins").and_then(|x| x.as_u64());
                                let resets = win.get("resetsAt").and_then(|x| x.as_i64()).and_then(|ts| {
                                    chrono::DateTime::from_timestamp(ts, 0).map(|dt| dt.to_rfc3339())
                                });
                                report.windows.push(QuotaWindowInfo {
                                    label: w_label.to_string(),
                                    used_percent: (used * 10.0).round() / 10.0,
                                    remaining_percent: (rem * 10.0).round() / 10.0,
                                    resets_at: resets,
                                    window_minutes: mins,
                                    models: Vec::new(),
                                });
                            }
                        }
                    }
                }
                if got_acc && got_rl {
                    break;
                }
            }
        }
        Ok::<(), String>(())
    })
    .await;

    let _ = child.kill().await;
    if let Err(_) = res {
        report.error = Some("Таймаут чтения лимитов Codex".to_string());
    }
    report
}

pub async fn run_acp_authenticate(
    exe: &str,
    args: &[String],
    envs: &[(&str, &str)],
    method_id: &str,
) -> Result<String, String> {
    let mut cmd = spawn_hidden_cmd(exe, args, envs);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    let init_line = format!(
        "{}\n",
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "ai-proxy-desktop", "title": "AI Proxy", "version": "0.1.0" }
            }
        })
    );
    stdin.write_all(init_line.as_bytes()).await.map_err(|e| e.to_string())?;

    let mut auth_sent = false;
    let res = tokio::time::timeout(std::time::Duration::from_secs(180), async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let id = v.get("id").and_then(|x| x.as_u64());
                if id == Some(1) && !auth_sent {
                    auth_sent = true;
                    let auth_line = format!(
                        "{}\n",
                        json!({
                            "jsonrpc": "2.0",
                            "id": 2,
                            "method": "authenticate",
                            "params": { "methodId": method_id }
                        })
                    );
                    stdin.write_all(auth_line.as_bytes()).await.map_err(|e| e.to_string())?;
                } else if id == Some(2) {
                    if let Some(err) = v.get("error") {
                        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("Auth failed");
                        return Err(msg.to_string());
                    }
                    return Ok("Вход выполнен успешно".to_string());
                }
            }
        }
        Err("Процесс авторизации завершился до подтверждения".to_string())
    })
    .await;

    let _ = child.kill().await;
    match res {
        Ok(inner) => inner,
        Err(_) => Err("Время ожидания входа истекло (180с)".to_string()),
    }
}

fn quoted_args(exe: &str, args: &[String]) -> String {
    std::iter::once(exe.to_string())
        .chain(args.iter().cloned())
        .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub async fn run_cli_login_interactive<F>(
    exe: &str,
    args: &[String],
    envs: &[(&str, &str)],
    verify: F,
) -> Result<String, String>
where
    F: Fn() -> bool,
{
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd.exe");
        let line = quoted_args(exe, args);
        cmd.args(["/C", "start", "\"AI Proxy — вход\"", "cmd.exe", "/K", &line]);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = spawn_hidden_cmd(exe, args, envs);
        cmd.spawn().map_err(|e| e.to_string())?;
    }

    for _ in 0..90 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if verify() {
            return Ok("Вход выполнен и подтверждён".to_string());
        }
    }
    Err("Вход не подтвердился: файл авторизации не появился за 3 минуты. Завершите вход в открывшемся окне терминала и повторите.".to_string())
}

pub async fn run_cli_login_command(
    exe: &str,
    args: &[String],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = spawn_hidden_cmd(exe, args, envs);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(180), child.wait_with_output())
        .await
        .map_err(|_| "Время ожидания CLI входа истекло (180с)".to_string())?
        .map_err(|e| e.to_string())?;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .trim()
    .to_string();

    if output.status.success() {
        Ok(if combined.is_empty() {
            "Команда входа выполнена".to_string()
        } else {
            combined
        })
    } else {
        Err(if combined.is_empty() {
            format!("Ошибка входа (код {:?})", output.status.code())
        } else {
            combined
        })
    }
}

fn auth_file_has_token(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    fn contains_nonempty_string(v: &Value, depth: u8) -> bool {
        if depth == 0 {
            return false;
        }
        match v {
            Value::String(s) => !s.trim().is_empty(),
            Value::Object(m) => m.values().any(|x| contains_nonempty_string(x, depth - 1)),
            Value::Array(a) => a.iter().any(|x| contains_nonempty_string(x, depth - 1)),
            _ => false,
        }
    }
    contains_nonempty_string(&value, 4)
}

pub fn check_simple_auth_status(settings: &AppSettings) -> HashMap<String, bool> {
    let mut map = HashMap::new();
    let home = dirs::home_dir().unwrap_or_default();
    let appdata = crate::discovery::openbot_app_data_dir();

    map.insert("codex".into(), auth_file_has_token(&home.join(".codex").join("auth.json")));
    map.insert("grok".into(), auth_file_has_token(&home.join(".grok").join("auth.json")) || settings.xai_api_key.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false));
    map.insert("devin".into(), appdata.join("devin").join("credentials.toml").exists() || home.join(".local").join("share").join("devin").join("credentials.toml").exists());
    map.insert("copilot".into(), home.join(".copilot").join("config.json").exists());
    map.insert("mistral".into(), home.join(".vibe").join(".env").exists() || home.join(".vibe").join("config.toml").exists());
    map
}

