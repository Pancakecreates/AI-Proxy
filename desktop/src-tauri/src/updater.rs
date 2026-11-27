use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const GITHUB_RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/Pancakecreates/AI-Proxy/releases/latest";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub release_notes: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: Option<u64>,
    pub published_at: Option<String>,
    pub checked_at: String,
}

fn parse_semver_tuple(raw: &str) -> (u64, u64, u64, bool) {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    let (core, is_pre) = match cleaned.split_once('-') {
        Some((a, _)) => (a, true),
        None => (cleaned, false),
    };
    let mut parts = core.split('.');
    let major = parts.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
    (major, minor, patch, is_pre)
}

pub fn is_newer_version(current: &str, latest: &str) -> bool {
    let (cmaj, cmin, cpat, cpre) = parse_semver_tuple(current);
    let (lmaj, lmin, lpat, lpre) = parse_semver_tuple(latest);
    if (lmaj, lmin, lpat) != (cmaj, cmin, cpat) {
        return (lmaj, lmin, lpat) > (cmaj, cmin, cpat);
    }
    cpre && !lpre
}

fn select_platform_asset<'a>(
    assets: &'a [serde_json::Value],
) -> Option<(&'a str, &'a str, Option<u64>)> {
    let mut best: Option<(i32, &'a str, &'a str, Option<u64>)> = None;

    for asset in assets {
        let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) else {
            continue;
        };
        let size = asset.get("size").and_then(|v| v.as_u64());
        let lower = name.to_lowercase();
        if lower.ends_with(".sig") || lower.ends_with(".json") {
            continue;
        }

        let score = if cfg!(target_os = "windows") {
            if lower.ends_with("-setup.exe") {
                100
            } else if lower.ends_with(".msi") {
                90
            } else if lower.ends_with(".exe") {
                80
            } else {
                0
            }
        } else if cfg!(target_os = "macos") {
            if lower.contains("universal") && lower.ends_with(".dmg") {
                100
            } else if cfg!(target_arch = "aarch64")
                && (lower.contains("aarch64") || lower.contains("arm64"))
                && lower.ends_with(".dmg")
            {
                95
            } else if lower.ends_with(".dmg") {
                80
            } else if lower.ends_with(".app.tar.gz") {
                70
            } else {
                0
            }
        } else if lower.ends_with(".appimage") {
            100
        } else if lower.ends_with(".deb") {
            90
        } else if lower.ends_with(".rpm") {
            70
        } else {
            0
        };

        if score > 0 && best.map(|b| score > b.0).unwrap_or(true) {
            best = Some((score, name, url, size));
        }
    }

    best.map(|(_, n, u, s)| (n, u, s))
}

pub async fn check_for_updates() -> Result<AppUpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("AI-Proxy-Desktop")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(GITHUB_RELEASES_LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub Releases ответил со статусом {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("name").and_then(|v| v.as_str()))
        .unwrap_or(&current);
    let latest_version = tag.trim().trim_start_matches(['v', 'V']).to_string();
    let release_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/Pancakecreates/AI-Proxy/releases/latest")
        .to_string();
    let release_notes = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let published_at = body
        .get("published_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let selected = select_platform_asset(assets);

    Ok(AppUpdateInfo {
        has_update: is_newer_version(&current, &latest_version),
        current_version: current,
        latest_version,
        release_url,
        release_notes,
        asset_name: selected.map(|(n, _, _)| n.to_string()),
        asset_url: selected.map(|(_, u, _)| u.to_string()),
        asset_size: selected.and_then(|(_, _, sz)| sz),
        published_at,
        checked_at: chrono::Utc::now().to_rfc3339(),
    })
}

pub async fn download_and_launch_update(
    app: &AppHandle,
    asset_url: Option<String>,
    asset_name: Option<String>,
    release_url: String,
) -> Result<String, String> {
    let Some(url) = asset_url.filter(|u| !u.trim().is_empty()) else {
        app.opener()
            .open_url(&release_url, None::<&str>)
            .map_err(|e| e.to_string())?;
        return Ok("Открыта страница релиза в браузере".to_string());
    };

    let filename = asset_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "ai-proxy-update-installer".to_string());

    let target_dir: PathBuf = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("ai-proxy-updates");
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target_path = target_dir.join(&filename);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("AI-Proxy-Desktop")
        .build()
        .map_err(|e| e.to_string())?;

    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Ошибка загрузки установщика: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ошибка сервера при загрузке: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    fs::write(&target_path, &bytes).map_err(|e| format!("Ошибка записи файла: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&target_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&target_path, perms);
        }
    }

    app.opener()
        .open_path(target_path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Скачано в {}, но не удалось открыть: {e}", target_path.display()))?;

    Ok(format!("Установщик скачан и запущен: {}", target_path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_works() {
        assert!(is_newer_version("0.1.0", "0.2.0"));
        assert!(is_newer_version("0.2.0", "v0.2.1"));
        assert!(is_newer_version("0.2.0-beta.1", "0.2.0"));
        assert!(!is_newer_version("0.2.0", "0.2.0"));
        assert!(!is_newer_version("0.3.0", "0.2.9"));
    }
}
