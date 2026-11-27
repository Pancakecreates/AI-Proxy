use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
    pub message: String,
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
            if lower.contains("setup") && lower.ends_with(".exe") {
                100
            } else if lower.ends_with(".exe") {
                90
            } else if lower.ends_with(".msi") {
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

fn emit_progress(app: &AppHandle, phase: &str, downloaded: u64, total: u64, message: impl Into<String>) {
    let percent = if total > 0 {
        ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "app-update-progress",
        UpdateDownloadProgress {
            phase: phase.to_string(),
            downloaded,
            total,
            percent,
            message: message.into(),
        },
    );
}

#[cfg(target_os = "windows")]
fn spawn_windows_silent_updater(installer_path: &PathBuf) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;

    let pid = std::process::id();
    let current_exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let esc = |s: &str| s.replace('\'', "''");
    let inst_str = installer_path.to_string_lossy().to_string();
    let is_msi = inst_str.to_lowercase().ends_with(".msi");

    let install_cmd = if is_msi {
        format!(
            "Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i','{}','/qn','/norestart') -Wait -WindowStyle Hidden",
            esc(&inst_str)
        )
    } else {
        format!(
            "Start-Process -FilePath '{}' -ArgumentList '/S' -Wait -WindowStyle Hidden",
            esc(&inst_str)
        )
    };

    let ps_script = format!(
        "$ErrorActionPreference = 'SilentlyContinue'; \
         try {{ Wait-Process -Id {pid} -Timeout 15 }} catch {{}}; \
         Start-Sleep -Milliseconds 350; \
         {install_cmd}; \
         $candidates = @('{}', (Join-Path $env:LOCALAPPDATA 'AI Proxy\\AI Proxy.exe')); \
         $target = $candidates | Where-Object {{ $_ -and (Test-Path $_) }} | Select-Object -First 1; \
         if ($target) {{ Start-Process -FilePath $target }}; \
         Remove-Item -LiteralPath '{}' -Force -ErrorAction SilentlyContinue",
        esc(&current_exe),
        esc(&inst_str),
    );

    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &ps_script,
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    cmd.spawn()
        .map_err(|e| format!("Не удалось запустить установщик обновления: {e}"))?;
    Ok(())
}

pub async fn download_and_launch_update(
    app: &AppHandle,
    asset_url: Option<String>,
    asset_name: Option<String>,
    release_url: String,
) -> Result<(String, bool), String> {
    let Some(url) = asset_url.filter(|u| !u.trim().is_empty()) else {
        app.opener()
            .open_url(&release_url, None::<&str>)
            .map_err(|e| e.to_string())?;
        return Ok(("Открыта страница релиза в браузере".to_string(), false));
    };

    let filename = asset_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "ai-proxy-update-installer.exe".to_string());

    let target_dir: PathBuf = app
        .path()
        .temp_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("ai-proxy-updates");
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target_path = target_dir.join(&filename);
    let part_path = target_dir.join(format!("{filename}.part"));

    emit_progress(app, "downloading", 0, 0, "Подключение к GitHub Releases...");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("AI-Proxy-Desktop")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Ошибка загрузки установщика: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ошибка сервера при загрузке: {e}"))?;

    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut file = File::create(&part_path).map_err(|e| format!("Ошибка создания файла: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Ошибка скачивания: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("Ошибка записи файла: {e}"))?;
        downloaded += bytes.len() as u64;
        if downloaded - last_emitted >= 65_536 || (total > 0 && downloaded >= total) {
            last_emitted = downloaded;
            let mb = downloaded as f64 / 1_048_576.0;
            let msg = if total > 0 {
                format!("Загрузка {mb:.1} из {:.1} МБ", total as f64 / 1_048_576.0)
            } else {
                format!("Загружено {mb:.1} МБ")
            };
            emit_progress(app, "downloading", downloaded, total, msg);
        }
    }
    file.flush().map_err(|e| format!("Ошибка записи файла: {e}"))?;
    drop(file);

    if target_path.exists() {
        let _ = fs::remove_file(&target_path);
    }
    fs::rename(&part_path, &target_path).map_err(|e| format!("Ошибка сохранения файла: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        emit_progress(
            app,
            "installing",
            total.max(downloaded),
            total.max(downloaded),
            "Установка обновления и перезапуск...",
        );
        spawn_windows_silent_updater(&target_path)?;
        return Ok(("Обновление загружено. Перезапуск AI Proxy...".to_string(), true));
    }

    #[cfg(not(target_os = "windows"))]
    {
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

        Ok((format!("Установщик скачан и запущен: {}", target_path.display()), false))
    }
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
