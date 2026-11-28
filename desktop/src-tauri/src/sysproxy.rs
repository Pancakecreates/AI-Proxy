use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const INTERNET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProxyBackup {
    enabled: u32,
    server: Option<String>,
    override_list: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyState {
    pub supported: bool,
    pub enabled: bool,
    pub server: Option<String>,
    pub applied_by_us: bool,
}

fn backup_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("ai-proxy"));
    dir.join("system-proxy-backup.json")
}

#[cfg(target_os = "windows")]
fn read_settings() -> Result<(u32, Option<String>, Option<String>), String> {
    use windows_registry::CURRENT_USER;
    let key = CURRENT_USER
        .open(INTERNET_SETTINGS_KEY)
        .map_err(|e| format!("Не удалось открыть настройки прокси Windows: {e}"))?;
    let enabled = key.get_u32("ProxyEnable").unwrap_or(0);
    let server = key.get_string("ProxyServer").ok();
    let override_list = key.get_string("ProxyOverride").ok();
    Ok((enabled, server, override_list))
}

#[cfg(target_os = "windows")]
fn write_settings(enabled: u32, server: Option<&str>, override_list: Option<&str>) -> Result<(), String> {
    use windows_registry::CURRENT_USER;
    let key = CURRENT_USER
        .create(INTERNET_SETTINGS_KEY)
        .map_err(|e| format!("Не удалось изменить настройки прокси Windows: {e}"))?;
    key.set_u32("ProxyEnable", enabled)
        .map_err(|e| format!("Не удалось записать ProxyEnable: {e}"))?;
    match server {
        Some(value) => key
            .set_string("ProxyServer", value)
            .map_err(|e| format!("Не удалось записать ProxyServer: {e}"))?,
        None => {
            let _ = key.remove_value("ProxyServer");
        }
    }
    match override_list {
        Some(value) => key
            .set_string("ProxyOverride", value)
            .map_err(|e| format!("Не удалось записать ProxyOverride: {e}"))?,
        None => {
            let _ = key.remove_value("ProxyOverride");
        }
    }
    notify_settings_changed();
    Ok(())
}

#[cfg(target_os = "windows")]
fn notify_settings_changed() {
    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };
    unsafe {
        InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null(), 0);
        InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
    }
}

/// WinINET stores a bare `host:port` for HTTP(S) and `socks=host:port` for SOCKS.
/// It cannot carry credentials inline, so reject those instead of silently
/// configuring a proxy that can never authenticate.
#[cfg(target_os = "windows")]
fn normalize_for_wininet(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Сначала укажите адрес прокси".to_string());
    }
    if trimmed.contains('@') {
        return Err(
            "Системный прокси Windows не поддерживает логин и пароль в адресе. Укажите прокси без учётных данных."
                .to_string(),
        );
    }
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| "Адрес прокси должен начинаться с http://, https:// или socks5://".to_string())?;
    let host_port = rest.trim_end_matches('/');
    if host_port.is_empty() {
        return Err("В адресе прокси нет хоста".to_string());
    }
    match scheme.to_lowercase().as_str() {
        "http" | "https" => Ok(host_port.to_string()),
        "socks5" | "socks5h" | "socks" => Ok(format!("socks={host_port}")),
        other => Err(format!("Неподдерживаемая схема прокси: {other}")),
    }
}

#[cfg(target_os = "windows")]
pub fn get_state(app: &AppHandle) -> SystemProxyState {
    let applied_by_us = backup_path(app).exists();
    match read_settings() {
        Ok((enabled, server, _)) => SystemProxyState {
            supported: true,
            enabled: enabled != 0,
            server,
            applied_by_us,
        },
        Err(_) => SystemProxyState {
            supported: true,
            enabled: false,
            server: None,
            applied_by_us,
        },
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_state(_app: &AppHandle) -> SystemProxyState {
    SystemProxyState {
        supported: false,
        enabled: false,
        server: None,
        applied_by_us: false,
    }
}

#[cfg(target_os = "windows")]
pub fn apply(app: &AppHandle, proxy_url: &str) -> Result<SystemProxyState, String> {
    let server = normalize_for_wininet(proxy_url)?;
    let backup_file = backup_path(app);
    if !backup_file.exists() {
        let (enabled, old_server, old_override) = read_settings()?;
        if let Some(parent) = backup_file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let backup = ProxyBackup {
            enabled,
            server: old_server,
            override_list: old_override,
        };
        std::fs::write(
            &backup_file,
            serde_json::to_vec_pretty(&backup).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Не удалось сохранить исходные настройки прокси: {e}"))?;
    }
    write_settings(1, Some(&server), Some("<local>;localhost;127.0.0.1;::1"))?;
    Ok(get_state(app))
}

#[cfg(not(target_os = "windows"))]
pub fn apply(_app: &AppHandle, _proxy_url: &str) -> Result<SystemProxyState, String> {
    Err("Системный прокси доступен только в Windows".to_string())
}

#[cfg(target_os = "windows")]
pub fn restore(app: &AppHandle) -> Result<SystemProxyState, String> {
    let backup_file = backup_path(app);
    if backup_file.exists() {
        let raw = std::fs::read(&backup_file).map_err(|e| e.to_string())?;
        let backup: ProxyBackup = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        write_settings(
            backup.enabled,
            backup.server.as_deref(),
            backup.override_list.as_deref(),
        )?;
        let _ = std::fs::remove_file(&backup_file);
    }
    Ok(get_state(app))
}

#[cfg(not(target_os = "windows"))]
pub fn restore(_app: &AppHandle) -> Result<SystemProxyState, String> {
    Ok(get_state(_app))
}

/// Best-effort restore used on exit paths where returning an error would only
/// leave the machine pointed at a dead proxy.
pub fn restore_quiet(app: &AppHandle) {
    let _ = restore(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn normalizes_http_and_socks() {
        assert_eq!(normalize_for_wininet("http://127.0.0.1:8080").unwrap(), "127.0.0.1:8080");
        assert_eq!(
            normalize_for_wininet("https://proxy.example:8443/").unwrap(),
            "proxy.example:8443"
        );
        assert_eq!(
            normalize_for_wininet("socks5://127.0.0.1:1080").unwrap(),
            "socks=127.0.0.1:1080"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_credentials_and_bad_schemes() {
        assert!(normalize_for_wininet("http://user:pass@host:8080").is_err());
        assert!(normalize_for_wininet("ftp://host:21").is_err());
        assert!(normalize_for_wininet("").is_err());
    }
}
