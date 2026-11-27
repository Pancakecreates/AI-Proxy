mod acp_client;
mod codex_client;
mod commands;
mod db;
mod discovery;
mod http_server;
mod models;
mod pricing;
mod quota;
mod router;
mod runtime_installer;
mod types;
mod updater;

use crate::acp_client::LogFn;
use crate::commands::AppState;
use crate::db::AppDb;
use crate::discovery::merge_antigravity_accounts;
use crate::router::BackendRouter;
use std::collections::HashMap;
use std::sync::{Arc, RwLock as StdRwLock};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::{Mutex, RwLock};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_handle_slot: Arc<StdRwLock<Option<AppHandle>>> = Arc::new(StdRwLock::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("ai-proxy-desktop"));
            let db = Arc::new(AppDb::open(&data_dir.join("proxy.db")).expect("open sqlite db"));

            let mut settings = db.load_settings().ok().flatten().unwrap_or_default();
            settings.antigravity_accounts = merge_antigravity_accounts(&settings.antigravity_accounts);
            if settings.api_key.as_deref().map(|k| k.trim().is_empty()).unwrap_or(true) {
                let raw = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
                settings.api_key = Some(format!("aipx_{}", &raw[..40]));
            }
            let _ = db.save_settings(&settings);

            *app_handle_slot.write().unwrap() = Some(app.handle().clone());

            let db_for_log = db.clone();
            let handle_for_log = app_handle_slot.clone();
            let log_fn: LogFn = Arc::new(move |level, source, message| {
                if let Ok(entry) = db_for_log.insert_app_log(level, source, message) {
                    if let Ok(guard) = handle_for_log.read() {
                        if let Some(h) = guard.as_ref() {
                            let _ = h.emit("app-log", &entry);
                        }
                    }
                }
            });

            let settings_lock = Arc::new(RwLock::new(settings.clone()));
            let router = BackendRouter::new(settings_lock.clone(), log_fn.clone());

            let state = Arc::new(AppState {
                db,
                settings: settings_lock,
                router,
                log: log_fn,
                server_handles: Mutex::new(Vec::new()),
                starting: Mutex::new(false),
                last_error: RwLock::new(None),
                chat_cancels: Mutex::new(HashMap::new()),
            });

            app.manage(state.clone());

            // Build system tray
            let show_item = MenuItem::with_id(app, "show", "Открыть AI Proxy", true, None::<&str>)?;
            let toggle_item = MenuItem::with_id(app, "toggle", "Запустить / Остановить прокси", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &toggle_item, &quit_item])?;

            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            let state_tray = state.clone();
            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("AI Proxy (Anthropic & OpenAI)")
                .menu(&menu)
                .on_menu_event(move |app_h, event| {
                    let id = event.id().as_ref();
                    if id == "show" {
                        if let Some(w) = app_h.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    } else if id == "toggle" {
                        let st = state_tray.clone();
                        let h = app_h.clone();
                        tauri::async_runtime::spawn(async move {
                            let is_running = !st.server_handles.lock().await.is_empty();
                            if is_running {
                                st.stop_proxy_internal().await;
                            } else {
                                let _ = st.start_proxy_internal(Some(h.clone())).await;
                            }
                            let _ = h.emit("proxy-status-updated", &st.runtime_status().await);
                        });
                    } else if id == "quit" {
                        let st = state_tray.clone();
                        let h = app_h.clone();
                        tauri::async_runtime::spawn(async move {
                            st.stop_proxy_internal().await;
                            h.exit(0);
                        });
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app_h = tray.app_handle();
                        if let Some(w) = app_h.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Auto-start HTTP proxy if configured
            if settings.auto_start_proxy {
                let st_boot = state.clone();
                let h_boot = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = st_boot.start_proxy_internal(Some(h_boot)).await;
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Arc<AppState>>().inner().clone();
                let minimize_to_tray = tauri::async_runtime::block_on(async {
                    state.settings.read().await.minimize_to_tray
                });
                if minimize_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    tauri::async_runtime::block_on(async {
                        state.stop_proxy_internal().await;
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_proxy_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::restart_proxy,
            commands::warm_up_backends,
            commands::list_models,
            commands::get_settings,
            commands::save_settings,
            commands::detect_runtimes,
            commands::download_provider_runtime,
            commands::get_accounts_and_quotas,
            commands::add_antigravity_account,
            commands::login_provider_account,
            commands::remove_or_logout_account,
            commands::query_request_logs,
            commands::query_app_logs,
            commands::clear_logs,
            commands::get_usage_summary,
            commands::list_chats,
            commands::create_chat,
            commands::update_chat_meta,
            commands::delete_chat,
            commands::get_chat_messages,
            commands::send_chat_message,
            commands::stop_chat_generation,
            commands::set_autostart,
            commands::get_autostart,
            commands::hide_main_window,
            commands::check_app_update,
            commands::download_and_launch_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

