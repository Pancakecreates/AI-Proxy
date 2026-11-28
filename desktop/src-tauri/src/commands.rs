use crate::acp_client::{LogFn, StreamEvent};
use crate::cancel::CancelToken;
use crate::db::AppDb;
use crate::discovery::{app_managed_accounts_dir, detect_all_runtimes, read_antigravity_account_email, resolve_runtime_executable};
use crate::http_server::{build_http_router, HttpSharedState};
use crate::models::normalize_effort_value;
use crate::pricing::{calculate_costs, estimate_tokens_from_chars};
use crate::quota::{
    check_simple_auth_status, fetch_antigravity_quota, fetch_codex_quota, run_acp_authenticate,
    run_cli_login_command, run_cli_login_interactive,
};
use crate::router::BackendRouter;
use crate::runtime_installer::install_provider_runtime;
use crate::types::{
    AccountQuotaReport, AntigravityAccountConfig, AppLogEntry, AppSettings, BackendModelEntry,
    ProviderAccountConfig,
    ChatMessageRecord, ChatSummary, DetectedRuntimes, NormalizedMessage, ProxyRuntimeStatus,
    RequestLogEntry, UnifiedTurnRequest, UsageSummary,
};
use chrono::Utc;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

pub struct ServerHandle {
    pub shutdown_tx: oneshot::Sender<()>,
}

pub struct AppState {
    pub db: Arc<AppDb>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub router: Arc<BackendRouter>,
    pub log: LogFn,
    pub server_handles: Mutex<Vec<ServerHandle>>,
    pub starting: Mutex<bool>,
    pub last_error: RwLock<Option<String>>,
    pub chat_cancels: Mutex<HashMap<String, Arc<CancelToken>>>,
}

impl AppState {
    pub async fn runtime_status(&self) -> ProxyRuntimeStatus {
        let handles = self.server_handles.lock().await;
        let running = !handles.is_empty();
        drop(handles);
        let starting = *self.starting.lock().await;
        let s = self.settings.read().await.clone();
        let backends = self.router.get_health_statuses().await;
        let models = self.router.list_models().await;
        let active_sessions = self.router.active_session_count().await;

        let anthropic_url = if running && s.enable_anthropic {
            Some(format!("http://{}:{}", s.host, s.anthropic_port))
        } else {
            None
        };
        let openai_url = if running && s.enable_openai {
            let port = if s.openai_port != s.anthropic_port {
                s.openai_port
            } else {
                s.anthropic_port
            };
            Some(format!("http://{}:{}/v1", s.host, port))
        } else {
            None
        };

        ProxyRuntimeStatus {
            running,
            starting,
            anthropic_url,
            openai_url,
            models_count: models.len(),
            active_sessions,
            backends,
            last_error: self.last_error.read().await.clone(),
        }
    }

    pub async fn start_proxy_internal(&self, app: Option<AppHandle>) -> Result<ProxyRuntimeStatus, String> {
        {
            let mut st = self.starting.lock().await;
            if *st {
                return Ok(self.runtime_status().await);
            }
            *st = true;
        }

        let result: Result<(), String> = async {
            self.stop_proxy_internal_logged(false).await;
            self.router.rebuild_backends().await;
            let s = self.settings.read().await.clone();
            let mut new_handles = Vec::new();

            let mut bind_errors: Vec<String> = Vec::new();
            let make_log_cb = |app_opt: Option<AppHandle>| {
                app_opt.map(|h| {
                    Arc::new(move |entry: &RequestLogEntry| {
                        let _ = h.emit("request-log", entry);
                    }) as Arc<dyn Fn(&RequestLogEntry) + Send + Sync>
                })
            };

            if s.enable_anthropic || (s.enable_openai && s.openai_port == s.anthropic_port) {
                let addr = format!("{}:{}", s.host, s.anthropic_port);
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(listener) => {
                        let http_state = HttpSharedState {
                            router: self.router.clone(),
                            settings: self.settings.clone(),
                            db: self.db.clone(),
                            on_request_log: make_log_cb(app.clone()),
                            force_openai: false,
                        };
                        let router = build_http_router(http_state);
                        let (tx, rx) = oneshot::channel::<()>();
                        tokio::spawn(async move {
                            let _ = axum::serve(listener, router)
                                .with_graceful_shutdown(async {
                                    let _ = rx.await;
                                })
                                .await;
                        });
                        new_handles.push(ServerHandle { shutdown_tx: tx });
                        (self.log)("info", "http", &format!("Anthropic/Unified HTTP запущен на http://{addr}"));
                    }
                    Err(e) => {
                        let msg = format!("Порт {} недоступен: {e}", s.anthropic_port);
                        (self.log)("error", "http", &msg);
                        bind_errors.push(msg);
                    }
                }
            }

            if s.enable_openai && s.openai_port != s.anthropic_port {
                let addr = format!("{}:{}", s.host, s.openai_port);
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(listener) => {
                        let http_state = HttpSharedState {
                            router: self.router.clone(),
                            settings: self.settings.clone(),
                            db: self.db.clone(),
                            on_request_log: make_log_cb(app.clone()),
                            force_openai: true,
                        };
                        let router = build_http_router(http_state);
                        let (tx, rx) = oneshot::channel::<()>();
                        tokio::spawn(async move {
                            let _ = axum::serve(listener, router)
                                .with_graceful_shutdown(async {
                                    let _ = rx.await;
                                })
                                .await;
                        });
                        new_handles.push(ServerHandle { shutdown_tx: tx });
                        (self.log)("info", "http", &format!("OpenAI HTTP запущен на http://{addr}/v1"));
                    }
                    Err(e) => {
                        let msg = format!("Порт {} недоступен: {e}", s.openai_port);
                        (self.log)("error", "http", &msg);
                        bind_errors.push(msg);
                    }
                }
            }

            if new_handles.is_empty() && !bind_errors.is_empty() {
                return Err(bind_errors.join("; "));
            }
            *self.server_handles.lock().await = new_handles;
            *self.last_error.write().await = if bind_errors.is_empty() {
                None
            } else {
                Some(bind_errors.join("; "))
            };
            Ok(())
        }
        .await;

        *self.starting.lock().await = false;

        if let Err(e) = result {
            *self.last_error.write().await = Some(e.clone());
            (self.log)("error", "http", &e);
            return Err(e);
        }

        // Warm up backends in background so UI responds immediately
        let router = self.router.clone();
        let app_clone = app.clone();
        let log = self.log.clone();
        tokio::spawn(async move {
            let models = router.warm_up(false).await;
            log("info", "router", &format!("Прогрев завершён: {} моделей доступно", models.len()));
            if let Some(h) = app_clone {
                let _ = h.emit("proxy-status-updated", json!({ "modelsCount": models.len() }));
            }
        });

        Ok(self.runtime_status().await)
    }

    pub async fn stop_proxy_internal(&self) {
        self.stop_proxy_internal_logged(true).await;
    }

    pub async fn stop_proxy_internal_logged(&self, log_stop: bool) {
        let handles = {
            let mut g = self.server_handles.lock().await;
            std::mem::take(&mut *g)
        };
        let was_running = !handles.is_empty();
        for h in handles {
            let _ = h.shutdown_tx.send(());
        }
        self.router.shutdown().await;
        if was_running && log_stop {
            (self.log)("info", "http", "Прокси остановлен");
        }
    }
}

#[tauri::command]
pub async fn get_proxy_status(state: State<'_, Arc<AppState>>) -> Result<ProxyRuntimeStatus, String> {
    Ok(state.runtime_status().await)
}

#[tauri::command]
pub async fn start_proxy(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<ProxyRuntimeStatus, String> {
    state.start_proxy_internal(Some(app)).await
}

#[tauri::command]
pub async fn stop_proxy(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<ProxyRuntimeStatus, String> {
    state.stop_proxy_internal().await;
    let st = state.runtime_status().await;
    let _ = app.emit("proxy-status-updated", &st);
    Ok(st)
}

#[tauri::command]
pub async fn restart_proxy(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<ProxyRuntimeStatus, String> {
    state.start_proxy_internal(Some(app)).await
}

#[tauri::command]
pub async fn warm_up_backends(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    force: bool,
) -> Result<Vec<BackendModelEntry>, String> {
    if force {
        state.router.rebuild_backends().await;
    }
    let models = state.router.warm_up(force).await;
    let _ = app.emit("proxy-status-updated", &state.runtime_status().await);
    Ok(models)
}

#[tauri::command]
pub async fn list_models(state: State<'_, Arc<AppState>>) -> Result<Vec<BackendModelEntry>, String> {
    Ok(state.router.list_models().await)
}

#[tauri::command]
pub async fn get_settings(state: State<'_, Arc<AppState>>) -> Result<AppSettings, String> {
    Ok(state.settings.read().await.clone())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    new_settings: AppSettings,
    restart_if_running: bool,
) -> Result<AppSettings, String> {
    state.db.save_settings(&new_settings)?;
    *state.settings.write().await = new_settings.clone();

    // Sync OS autostart
    let autolaunch = app.autolaunch();
    if new_settings.autostart_os {
        let _ = autolaunch.enable();
    } else {
        let _ = autolaunch.disable();
    }

    if restart_if_running && !state.server_handles.lock().await.is_empty() {
        let _ = state.start_proxy_internal(Some(app.clone())).await;
    }
    let _ = app.emit("settings-updated", &new_settings);
    Ok(new_settings)
}

#[tauri::command]
pub async fn detect_runtimes(state: State<'_, Arc<AppState>>) -> Result<DetectedRuntimes, String> {
    let s = state.settings.read().await.clone();
    Ok(detect_all_runtimes(&s))
}

#[tauri::command]
pub async fn download_provider_runtime(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    provider: String,
) -> Result<String, String> {
    let path = install_provider_runtime(&provider, Some(app.clone())).await?;
    (state.log)("info", "installer", &format!("Установлен CLI {provider}: {path}"));
    Ok(path)
}


pub const ACCOUNT_PROVIDERS: &[&str] = &[
    "devin", "antigravity", "opencode", "grok", "codex", "copilot", "cursor", "cline", "mistral", "kimi", "hermes",
];

fn resolve_provider_exe(s: &AppSettings, provider: &str) -> Option<String> {
    match provider {
        "devin" => resolve_runtime_executable("devin", &["devin"], s.devin_path.as_deref()),
        "antigravity" => resolve_runtime_executable("antigravity", &["antigravity"], s.antigravity_path.as_deref()),
        "opencode" => resolve_runtime_executable("opencode", &["opencode"], s.opencode_path.as_deref()),
        "grok" => resolve_runtime_executable("grok", &["grok"], s.grok_path.as_deref()),
        "codex" => resolve_runtime_executable("codex", &["codex"], s.codex_path.as_deref()),
        "copilot" => resolve_runtime_executable("copilot", &["copilot"], s.copilot_path.as_deref()),
        "cursor" => resolve_runtime_executable("cursor", &["cursor-agent", "agent"], s.cursor_path.as_deref()),
        "cline" => resolve_runtime_executable("cline", &["cline"], s.cline_path.as_deref()),
        "mistral" => resolve_runtime_executable("mistral", &["vibe-acp", "vibe"], s.mistral_path.as_deref()),
        "kimi" => resolve_runtime_executable("kimi", &["kimi"], s.kimi_path.as_deref()),
        "hermes" => resolve_runtime_executable("hermes", &["hermes"], s.hermes_path.as_deref()),
        _ => None,
    }
}

fn find_provider_account<'a>(s: &'a AppSettings, provider: &str, account_id: Option<&str>) -> Option<crate::types::ProviderAccountConfig> {
    let aid = account_id?;
    crate::accounts::accounts_for_provider(s, provider)
        .into_iter()
        .find(|a| a.id == aid)
}

fn account_login_envs(acc: Option<&crate::types::ProviderAccountConfig>, provider: &str) -> Vec<(String, String)> {
    let Some(acc) = acc else { return Vec::new() };
    if provider == "antigravity" {
        return Vec::new();
    }
    crate::accounts::profile_env_overrides(provider, acc)
        .into_iter()
        .filter_map(|(k, v)| v.map(|val| (k, val)))
        .collect()
}

fn account_profile_signed_in(provider: &str, acc: &crate::types::ProviderAccountConfig) -> bool {
    let dir = Path::new(&acc.profile_dir);
    if !dir.is_dir() {
        return false;
    }
    match provider {
        "antigravity" => {
            let app_data = acc.app_data_dir.clone().unwrap_or_else(|| "antigravity-acp".into());
            dir.join(app_data).join("antigravity-oauth-token").is_file()
        }
        "codex" => dir.join("auth.json").is_file(),
        "opencode" => dir.join("opencode.db").is_file(),
        _ => std::fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false),
    }
}

#[tauri::command]
pub async fn get_accounts_and_quotas(state: State<'_, Arc<AppState>>) -> Result<Vec<AccountQuotaReport>, String> {
    let s = state.settings.read().await.clone();
    let rt = detect_all_runtimes(&s);
    let simple_auth = check_simple_auth_status(&s);

    let mut reports = Vec::new();
    let agy_futures: Vec<_> = rt
        .antigravity_accounts
        .iter()
        .map(|acc| fetch_antigravity_quota(acc, s.proxy_url.as_deref()))
        .collect();
    let agy_results = futures::future::join_all(agy_futures).await;
    reports.extend(agy_results);

    if rt.codex_path.is_some() {
        reports.push(fetch_codex_quota(&s).await);
    }

    for (prov, label) in [
        ("devin", "Devin"),
        ("grok", "Grok (xAI)"),
        ("copilot", "GitHub Copilot"),
        ("mistral", "Mistral Vibe"),
    ] {
        let signed = simple_auth.get(prov).copied().unwrap_or(false);
        reports.push(AccountQuotaReport {
            account_key: prov.to_string(),
            provider: prov.to_string(),
            label: label.to_string(),
            email: None,
            signed_in: signed,
            windows: Vec::new(),
            error: None,
            verification_url: None,
            checked_at: Utc::now().to_rfc3339(),
        });
    }

    // Per-account reports for providers with configured profile accounts.
    for prov in ACCOUNT_PROVIDERS {
        if *prov == "antigravity" {
            continue;
        }
        for acc in crate::accounts::accounts_for_provider(&s, prov) {
            let key = format!("{prov}:{}", acc.id);
            if reports.iter().any(|r| r.account_key == key) {
                continue;
            }
let email = acc.email.clone();
            reports.push(AccountQuotaReport {
                account_key: key,
                provider: prov.to_string(),
                label: format!("{} ({})", prov, acc.label),
                email,
                signed_in: account_profile_signed_in(prov, &acc),
                windows: Vec::new(),
                error: None,
                verification_url: None,
                checked_at: Utc::now().to_rfc3339(),
            });
        }
    }

    Ok(reports)
}

#[tauri::command]
pub async fn add_antigravity_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    label: Option<String>,
) -> Result<AntigravityAccountConfig, String> {
    let s = state.settings.read().await.clone();
    let exe = resolve_runtime_executable("antigravity", &["antigravity"], s.antigravity_path.as_deref())
        .ok_or("Antigravity CLI не найден — сначала скачайте или укажите путь к antigravity")?;

    let short_id = format!("agy-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]);
    let dir = app_managed_accounts_dir().join(&short_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let app_data_dir = "antigravity-acp".to_string();

    let args = vec![
        "acp".to_string(),
        format!("--gemini-dir={}", dir.to_string_lossy()),
        format!("--app-data-dir={app_data_dir}"),
    ];
    let envs = [("WSL_DISTRO_NAME", "OpenBot"), ("ANTIGRAVITY_CLI_NO_AUTO_UPDATE", "1")];
    run_acp_authenticate(&exe, &args, &envs, "oauth-personal").await?;

    let email = read_antigravity_account_email(&dir.join(&app_data_dir));
    let acc = AntigravityAccountConfig {
        id: short_id,
        label: label
            .filter(|l| !l.trim().is_empty())
            .or_else(|| email.clone())
            .unwrap_or_else(|| "Antigravity Account".to_string()),
        gemini_dir: dir.to_string_lossy().to_string(),
        app_data_dir,
        email,
        enabled: true,
        managed: true,
    };

    let mut updated = state.settings.read().await.clone();
    updated.antigravity_accounts = crate::discovery::merge_antigravity_accounts(&updated.antigravity_accounts);
    if !updated.antigravity_accounts.iter().any(|a| a.gemini_dir == acc.gemini_dir) {
        updated.antigravity_accounts.push(acc.clone());
    }
    state.db.save_settings(&updated)?;
    *state.settings.write().await = updated;
    let _ = app.emit("proxy-status-updated", &state.runtime_status().await);
    Ok(acc)
}

#[tauri::command]
pub async fn add_provider_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    provider: String,
    label: Option<String>,
) -> Result<ProviderAccountConfig, String> {
    if !ACCOUNT_PROVIDERS.contains(&provider.as_str()) {
        return Err(format!("Мультиаккаунты для «{provider}» не поддерживаются"));
    }
    let s = state.settings.read().await.clone();
    resolve_provider_exe(&s, &provider)
        .ok_or_else(|| format!("CLI {provider} не найден — сначала скачайте или укажите путь"))?;

    let short_id = format!("{}-{}", &provider[..3.min(provider.len())], &uuid::Uuid::new_v4().simple().to_string()[..6]);
    let dir = app_managed_accounts_dir().join(&provider).join(&short_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let count = crate::accounts::accounts_for_provider(&s, &provider).len();
    let acc = ProviderAccountConfig {
        id: short_id,
        label: label
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| format!("Account {}", count + 1)),
        profile_dir: dir.to_string_lossy().to_string(),
        app_data_dir: if provider == "antigravity" { Some("antigravity-acp".into()) } else { None },
        email: None,
        enabled: true,
        managed: true,
    };
    crate::accounts::prepare_profile_dirs(&provider, &acc)?;

    let mut updated = state.settings.read().await.clone();
    updated
        .provider_accounts
        .entry(provider.clone())
        .or_default()
        .push(acc.clone());
    state.db.save_settings(&updated)?;
    *state.settings.write().await = updated;
    state.router.rebuild_backends().await;
    let _ = app.emit("proxy-status-updated", &state.runtime_status().await);
    Ok(acc)
}

#[tauri::command]
pub async fn login_provider_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    provider: String,
    account_id: Option<String>,
) -> Result<String, String> {
    let s = state.settings.read().await.clone();
    let acc = find_provider_account(&s, &provider, account_id.as_deref());
    if account_id.is_some() && acc.is_none() {
        return Err(format!("Аккаунт {provider} не найден"));
    }
    let extra = account_login_envs(acc.as_ref(), &provider);
    let extra_refs: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    fn with_extra<'a>(base: &[(&'a str, &'a str)], extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        let mut v: Vec<(&'a str, &'a str)> = base.to_vec();
        v.extend_from_slice(extra);
        v
    }

    let msg = match provider.as_str() {
        "antigravity" => {
            let exe = resolve_provider_exe(&s, "antigravity")
                .ok_or("Antigravity CLI не установлен")?;
            let acc = acc.ok_or("Сначала добавьте аккаунт Antigravity")?;
            let app_data = acc.app_data_dir.clone().unwrap_or_else(|| "antigravity-acp".into());
            let args = vec![
                "acp".to_string(),
                format!("--gemini-dir={}", acc.profile_dir),
                format!("--app-data-dir={app_data}"),
            ];
            run_acp_authenticate(
                &exe,
                &args,
                &with_extra(&[("WSL_DISTRO_NAME", "OpenBot"), ("ANTIGRAVITY_CLI_NO_AUTO_UPDATE", "1")], &extra_refs),
                "oauth-personal",
            )
            .await?
        }
        "devin" => {
            let exe = resolve_provider_exe(&s, "devin").ok_or("Devin CLI не установлен")?;
            run_acp_authenticate(&exe, &["acp".into()], &with_extra(&[], &extra_refs), "devin-browser").await?
        }
        "mistral" => {
            let exe = resolve_provider_exe(&s, "mistral").ok_or("Mistral Vibe CLI не установлен")?;
            run_acp_authenticate(&exe, &[], &with_extra(&[], &extra_refs), "browser-auth").await?
        }
        "cline" => {
            let exe = resolve_provider_exe(&s, "cline").ok_or("Cline CLI не установлен")?;
            run_acp_authenticate(&exe, &["--acp".into()], &with_extra(&[("CLINE_SESSION_BACKEND_MODE", "local")], &extra_refs), "cline").await?
        }
        "codex" => {
            let exe = resolve_provider_exe(&s, "codex").ok_or("Codex CLI не установлен")?;
            run_cli_login_interactive(&exe, &["login".into()], &with_extra(&[], &extra_refs), || {
                check_simple_auth_status(&s).get("codex").copied().unwrap_or(false)
            }).await?
        }
        "grok" => {
            let exe = resolve_provider_exe(&s, "grok").ok_or("Grok CLI не установлен")?;
            run_cli_login_interactive(
                &exe,
                &["--no-auto-update".into(), "login".into()],
                &with_extra(&[("GROK_OAUTH2_REFERRER", "openbot")], &extra_refs),
                || check_simple_auth_status(&s).get("grok").copied().unwrap_or(false),
            )
            .await?
        }
        "copilot" => {
            let exe = resolve_provider_exe(&s, "copilot").ok_or("Copilot CLI не установлен")?;
            run_cli_login_interactive(&exe, &["login".into()], &with_extra(&[], &extra_refs), || {
                check_simple_auth_status(&s).get("copilot").copied().unwrap_or(false)
            }).await?
        }
        "opencode" => {
            let exe = resolve_provider_exe(&s, "opencode").ok_or("OpenCode CLI не установлен")?;
            run_cli_login_command(&exe, &["auth".into(), "login".into()], &with_extra(&[], &extra_refs)).await?
        }
        "kimi" => {
            let exe = resolve_provider_exe(&s, "kimi").ok_or("Kimi CLI не установлен")?;
            run_cli_login_command(&exe, &["login".into()], &with_extra(&[], &extra_refs)).await?
        }
        "hermes" => {
            let exe = resolve_provider_exe(&s, "hermes").ok_or("Hermes CLI не установлен")?;
            run_cli_login_command(&exe, &["auth".into(), "add".into(), "nous".into(), "--type".into(), "oauth".into()], &with_extra(&[], &extra_refs)).await?
        }
        other => return Err(format!("Вход для \"{other}\" не поддерживается")),
    };

    (state.log)("info", "auth", &format!("Вход {provider}: {msg}"));
    let _ = app.emit("proxy-status-updated", &state.runtime_status().await);
    Ok(msg)
}

#[tauri::command]
pub async fn remove_or_logout_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    provider: String,
    account_id: Option<String>,
    delete_files: bool,
) -> Result<(), String> {
    let mut s = state.settings.read().await.clone();

    // Generic profile-account removal (any provider with configured accounts).
    if let Some(aid) = account_id.clone() {
        let acc = find_provider_account(&s, &provider, Some(&aid));
        if provider == "antigravity" {
            let mut merged = crate::discovery::merge_antigravity_accounts(&s.antigravity_accounts);
            if let Some(pos) = merged.iter().position(|a| a.id == aid) {
                let removed = merged.remove(pos);
                if delete_files {
                    let token_path = Path::new(&removed.gemini_dir).join(&removed.app_data_dir);
                    let _ = std::fs::remove_dir_all(token_path);
                    if removed.managed {
                        let _ = std::fs::remove_dir_all(&removed.gemini_dir);
                    }
                }
            }
            s.antigravity_accounts = merged;
        }
        if let Some(list) = s.provider_accounts.get_mut(&provider) {
            if let Some(pos) = list.iter().position(|a| a.id == aid) {
                let removed = list.remove(pos);
                if delete_files && removed.managed {
                    let _ = std::fs::remove_dir_all(&removed.profile_dir);
                }
            }
        }
        if acc.is_some() || provider == "antigravity" {
            state.db.save_settings(&s)?;
            *state.settings.write().await = s;
            state.router.rebuild_backends().await;
            let _ = app.emit("proxy-status-updated", &state.runtime_status().await);
            return Ok(());
        }
    }

    match provider.as_str() {
        "codex" => {
            if let Some(exe) = resolve_provider_exe(&s, "codex") {
                let _ = run_cli_login_command(&exe, &["logout".into()], &[]).await;
            }
        }
        "devin" => {
            if let Some(exe) = resolve_provider_exe(&s, "devin") {
                let _ = run_cli_login_command(&exe, &["auth".into(), "logout".into()], &[]).await;
            }
        }
        "grok" => {
            if let Some(exe) = resolve_provider_exe(&s, "grok") {
                let _ = run_cli_login_command(&exe, &["--no-auto-update".into(), "logout".into()], &[]).await;
            }
        }
        _ => {}
    }
    let _ = app.emit("proxy-status-updated", &state.runtime_status().await);
    Ok(())
}

#[tauri::command]
pub async fn query_request_logs(
    state: State<'_, Arc<AppState>>,
    limit: Option<usize>,
    search: Option<String>,
) -> Result<Vec<RequestLogEntry>, String> {
    state.db.query_request_logs(limit.unwrap_or(150), search.as_deref())
}

#[tauri::command]
pub async fn query_app_logs(
    state: State<'_, Arc<AppState>>,
    limit: Option<usize>,
    level: Option<String>,
) -> Result<Vec<AppLogEntry>, String> {
    state.db.query_app_logs(limit.unwrap_or(200), level.as_deref())
}

#[tauri::command]
pub async fn clear_logs(state: State<'_, Arc<AppState>>, kind: String) -> Result<(), String> {
    state.db.clear_logs(&kind)
}

#[tauri::command]
pub async fn get_usage_summary(state: State<'_, Arc<AppState>>, days: Option<i64>) -> Result<UsageSummary, String> {
    state.db.get_usage_summary(days.unwrap_or(30))
}

#[tauri::command]
pub async fn list_chats(state: State<'_, Arc<AppState>>) -> Result<Vec<ChatSummary>, String> {
    state.db.list_chats()
}

#[tauri::command]
pub async fn create_chat(
    state: State<'_, Arc<AppState>>,
    title: String,
    model_id: String,
    protocol: String,
    effort: String,
    system_prompt: String,
) -> Result<ChatSummary, String> {
    let now = Utc::now().to_rfc3339();
    let chat = ChatSummary {
        id: uuid::Uuid::new_v4().to_string(),
        title: if title.trim().is_empty() { "Новый тестовый чат".into() } else { title },
        model_id,
        protocol,
        effort,
        system_prompt,
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
    };
    state.db.create_chat(&chat)?;
    Ok(chat)
}

#[tauri::command]
pub async fn update_chat_meta(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    title: Option<String>,
    model_id: Option<String>,
    protocol: Option<String>,
    effort: Option<String>,
    system_prompt: Option<String>,
) -> Result<(), String> {
    state.db.update_chat_meta(
        &chat_id,
        title.as_deref(),
        model_id.as_deref(),
        protocol.as_deref(),
        effort.as_deref(),
        system_prompt.as_deref(),
    )
}

#[tauri::command]
pub async fn delete_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    state.db.delete_chat(&chat_id)
}

#[tauri::command]
pub async fn get_chat_messages(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
) -> Result<Vec<ChatMessageRecord>, String> {
    state.db.get_chat_messages(&chat_id)
}

#[tauri::command]
pub async fn send_chat_message(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    content: String,
    model_id: String,
    effort: String,
    protocol: String,
    system_prompt: String,
) -> Result<ChatMessageRecord, String> {
    let start = std::time::Instant::now();
    let now = Utc::now().to_rfc3339();
    let user_msg = ChatMessageRecord {
        id: uuid::Uuid::new_v4().to_string(),
        chat_id: chat_id.clone(),
        role: "user".into(),
        content: content.clone(),
        thinking: String::new(),
        model_id: Some(model_id.clone()),
        effort: Some(effort.clone()),
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        cost_usd: 0.0,
        usage_source: "none".into(),
        created_at: now,
    };
    state.db.insert_chat_message(&user_msg)?;

    let history = state.db.get_chat_messages(&chat_id)?;
    let norm_messages: Vec<NormalizedMessage> = history
        .iter()
        .map(|m| NormalizedMessage {
            role: m.role.clone(),
            text: m.content.clone(),
            images: Vec::new(),
        })
        .collect();

    let requested_effort = normalize_effort_value(Some(&effort));
    let unified = UnifiedTurnRequest {
        model: Some(model_id.clone()),
        system: system_prompt.clone(),
        messages: norm_messages,
        requested_effort,
        thinking_disabled: effort == "none",
        thinking_budget: None,
        requested_speed: None,
        cwd: None,
    };

    let mut est_chars = system_prompt.len();
    for m in &history {
        est_chars += m.content.len();
    }

    let cancel = CancelToken::new();
    state.chat_cancels.lock().await.insert(chat_id.clone(), cancel.clone());

    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let app_stream = app.clone();
    let cid_stream = chat_id.clone();
    let stream_task = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Thinking(chunk) => {
                    let _ = app_stream.emit("chat-stream", json!({ "chatId": cid_stream, "kind": "thinking", "chunk": chunk }));
                }
                StreamEvent::Text(chunk) => {
                    let _ = app_stream.emit("chat-stream", json!({ "chatId": cid_stream, "kind": "text", "chunk": chunk }));
                }
                StreamEvent::Usage { input_tokens, output_tokens } => {
                    let _ = app_stream.emit("chat-stream", json!({ "chatId": cid_stream, "kind": "usage", "inputTokens": input_tokens, "outputTokens": output_tokens }));
                }
            }
        }
    });

    let turn_res = state.router.run_turn(unified, Some(tx), Some(cancel)).await;
    state.chat_cancels.lock().await.remove(&chat_id);
    let _ = stream_task.await;

    let s = state.settings.read().await.clone();
    match turn_res {
        Ok(out) => {
            let res = out.turn;
            let bkey = out.backend_key;
            let blabel = out.backend_label;
            let bkind = out.backend_kind;
            let eff = out.effective_effort;
            let in_tok = if res.usage.input_tokens > 0 { res.usage.input_tokens } else { estimate_tokens_from_chars(est_chars) };
            let out_tok = if res.usage.output_tokens > 0 { res.usage.output_tokens } else { estimate_tokens_from_chars(res.assistant_text.len() + res.thinking_text.len()) };
            let (cost_usd, eq_usd) = calculate_costs(&s, bkind, &res.model_id, in_tok, out_tok);
            let latency_ms = start.elapsed().as_millis() as u64;
            let src = if res.usage.measured { "measured" } else { "estimated" }.to_string();

            let _ = state.db.insert_request_log(&RequestLogEntry {
                id: 0,
                created_at: Utc::now().to_rfc3339(),
                request_id: format!("chat_{}", uuid::Uuid::new_v4().simple()),
                protocol: format!("sandbox-{protocol}"),
                method: "CHAT".into(),
                path: "/sandbox".into(),
                model: model_id.clone(),
                resolved_model: Some(res.model_id.clone()),
                effort: eff.clone(),
                backend_key: Some(bkey),
                account_label: Some(blabel),
                status: 200,
                latency_ms,
                input_tokens: in_tok,
                output_tokens: out_tok,
                cache_read_tokens: res.usage.cache_read_tokens,
                thinking_tokens: res.usage.thinking_tokens,
                usage_source: src.clone(),
                cost_usd,
                api_equivalent_usd: eq_usd,
                error: None,
                prompt_preview: Some(content.chars().take(180).collect()),
                response_preview: Some(res.assistant_text.chars().take(180).collect()),
            });

            let reply = ChatMessageRecord {
                id: uuid::Uuid::new_v4().to_string(),
                chat_id,
                role: "assistant".into(),
                content: res.assistant_text,
                thinking: res.thinking_text,
                model_id: Some(res.model_id),
                effort: Some(effort),
                input_tokens: in_tok,
                output_tokens: out_tok,
                latency_ms,
                cost_usd,
                usage_source: src,
                created_at: Utc::now().to_rfc3339(),
            };
            state.db.insert_chat_message(&reply)?;
            Ok(reply)
        }
        Err(err) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            let _ = state.db.insert_request_log(&RequestLogEntry {
                id: 0,
                created_at: Utc::now().to_rfc3339(),
                request_id: format!("chat_{}", uuid::Uuid::new_v4().simple()),
                protocol: format!("sandbox-{protocol}"),
                method: "CHAT".into(),
                path: "/sandbox".into(),
                model: model_id,
                resolved_model: err.resolved_model,
                effort: err.effort,
                backend_key: err.backend_key,
                account_label: err.backend_label,
                status: 502,
                latency_ms,
                input_tokens: estimate_tokens_from_chars(est_chars),
                output_tokens: 0,
                cache_read_tokens: 0,
                thinking_tokens: 0,
                usage_source: "estimated".into(),
                cost_usd: 0.0,
                api_equivalent_usd: 0.0,
                error: Some(err.message.clone()),
                prompt_preview: Some(content.chars().take(180).collect()),
                response_preview: None,
            });
            Err(err.message)
        }
    }
}

#[tauri::command]
pub async fn stop_chat_generation(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    if let Some(n) = state.chat_cancels.lock().await.get(&chat_id).cloned() {
        n.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn set_autostart(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<bool, String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    let mut s = state.settings.read().await.clone();
    s.autostart_os = enabled;
    state.db.save_settings(&s)?;
    *state.settings.write().await = s;
    Ok(enabled)
}

#[tauri::command]
pub async fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    state.stop_proxy_internal().await;
    app.exit(0);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProviderTestResult {
    pub models_count: usize,
    pub sample_models: Vec<String>,
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn test_external_provider(
    state: State<'_, Arc<AppState>>,
    config: crate::types::ExternalProviderConfig,
) -> Result<ExternalProviderTestResult, String> {
    let settings = state.settings.clone();
    let log: crate::acp_client::LogFn = Arc::new(|_, _, _| {});
    let backend = crate::external_client::ExternalBackend::new(config, settings, log);
    let started = std::time::Instant::now();
    let models = backend.warm_up(true).await?;
    let sample = models
        .iter()
        .take(6)
        .map(|m| m.native_id.clone())
        .collect::<Vec<_>>();
    Ok(ExternalProviderTestResult {
        models_count: models.len(),
        sample_models: sample,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub latency_ms: u64,
    pub external_ip: Option<String>,
}

#[tauri::command]
pub async fn test_proxy_connection(proxy_url: String) -> Result<ProxyTestResult, String> {
    let client = crate::net::build_client(
        Some(&proxy_url),
        Some(std::time::Duration::from_secs(15)),
    )?;
    let started = std::time::Instant::now();
    let resp = client
        .get("https://api.ipify.org")
        .send()
        .await
        .map_err(|e| format!("Соединение через прокси не удалось: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Проверочный запрос через прокси вернул HTTP {}", resp.status()));
    }
    let body = resp.text().await.unwrap_or_default();
    let ip = body.trim().chars().take(64).collect::<String>();
    Ok(ProxyTestResult {
        latency_ms: started.elapsed().as_millis() as u64,
        external_ip: if ip.is_empty() { None } else { Some(ip) },
    })
}

#[tauri::command]
pub async fn check_app_update() -> Result<crate::updater::AppUpdateInfo, String> {
    crate::updater::check_for_updates().await
}

#[tauri::command]
pub async fn download_and_launch_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    asset_url: Option<String>,
    asset_name: Option<String>,
    release_url: String,
) -> Result<String, String> {
    let (msg, should_restart) =
        crate::updater::download_and_launch_update(&app, asset_url, asset_name, release_url).await?;
    if should_restart {
        // Schedule the exit first: a slow or stuck proxy shutdown must never
        // prevent the app from exiting, or the update installer will find
        // locked files. The updater script force-kills us as a last resort.
        let app_h = app.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            app_h.exit(0);
        });
        let st = state.inner().clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                st.stop_proxy_internal(),
            )
            .await;
        });
    }
    Ok(msg)
}


