use crate::discovery::openbot_app_data_dir;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallProgress {
    pub provider: String,
    pub status: String,
    pub progress_percent: f64,
    pub message: String,
}

fn platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "win32-x64"
    }
    #[cfg(target_os = "macos")]
    {
        if cfg!(target_arch = "aarch64") {
            "darwin-arm64"
        } else {
            "darwin-x64"
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if cfg!(target_arch = "aarch64") {
            "linux-arm64"
        } else {
            "linux-x64"
        }
    }
}

struct DownloadSpec {
    version: &'static str,
    url: String,
    archive_kind: &'static str, // "zip" | "targz" | "raw_exe"
    exe_name: &'static str,
}

fn spec_for_provider(provider: &str) -> Result<DownloadSpec, String> {
    let plat = platform_key();
    match provider {
        "devin" => {
            let ver = "3000.14.30821";
            let (file, kind, exe) = match plat {
                "win32-x64" => (format!("devin-{ver}-x86_64-pc-windows.zip"), "zip", "devin.exe"),
                "darwin-arm64" => (format!("devin-{ver}-aarch64-apple-darwin.tar.gz"), "targz", "devin"),
                "darwin-x64" => (format!("devin-{ver}-x86_64-apple-darwin.tar.gz"), "targz", "devin"),
                "linux-arm64" => (format!("devin-{ver}-aarch64-unknown-linux.tar.gz"), "targz", "devin"),
                _ => (format!("devin-{ver}-x86_64-unknown-linux.tar.gz"), "targz", "devin"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://static.devin.ai/cli/{ver}/{file}"),
                archive_kind: kind,
                exe_name: exe,
            })
        }
        "antigravity" => {
            let ver = "1.5.4";
            let (file, kind, exe) = match plat {
                "win32-x64" => ("agy_cli_windows_x64.zip", "zip", "antigravity.exe"),
                "darwin-arm64" => ("agy_cli_mac_arm64.tar.gz", "targz", "antigravity"),
                "darwin-x64" => ("agy_cli_mac_x64.tar.gz", "targz", "antigravity"),
                "linux-arm64" => ("agy_cli_linux_arm64.tar.gz", "targz", "antigravity"),
                _ => ("agy_cli_linux_x64.tar.gz", "targz", "antigravity"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://github.com/google-antigravity/antigravity-cli/releases/download/{ver}/{file}"),
                archive_kind: kind,
                exe_name: exe,
            })
        }
        "codex" => {
            let ver = "0.170.0";
            let tag = "rust-v0.170.0";
            let (file, exe) = match plat {
                "win32-x64" => ("codex-package-x86_64-pc-windows-msvc.tar.gz", "codex.exe"),
                "darwin-arm64" => ("codex-package-aarch64-apple-darwin.tar.gz", "codex"),
                "darwin-x64" => ("codex-package-x86_64-apple-darwin.tar.gz", "codex"),
                "linux-arm64" => ("codex-package-aarch64-unknown-linux-musl.tar.gz", "codex"),
                _ => ("codex-package-x86_64-unknown-linux-musl.tar.gz", "codex"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://github.com/openai/codex/releases/download/{tag}/{file}"),
                archive_kind: "targz",
                exe_name: exe,
            })
        }
        "opencode" => {
            let ver = "2.2.5";
            let (pkg, tgz, exe) = match plat {
                "win32-x64" => ("@opencode/cli-windows-x64", format!("cli-windows-x64-{ver}.tgz"), "opencode.exe"),
                "darwin-arm64" => ("@opencode/cli-darwin-arm64", format!("cli-darwin-arm64-{ver}.tgz"), "opencode"),
                "darwin-x64" => ("@opencode/cli-darwin-x64", format!("cli-darwin-x64-{ver}.tgz"), "opencode"),
                "linux-arm64" => ("@opencode/cli-linux-arm64", format!("cli-linux-arm64-{ver}.tgz"), "opencode"),
                _ => ("@opencode/cli-linux-x64", format!("cli-linux-x64-{ver}.tgz"), "opencode"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://registry.npmjs.org/{pkg}/-/{tgz}"),
                archive_kind: "targz",
                exe_name: exe,
            })
        }
        "grok" => {
            let ver = "1.0.22";
            let (file, exe) = match plat {
                "win32-x64" => (format!("grok-{ver}-windows-x86_64.exe"), "grok.exe"),
                "darwin-arm64" => (format!("grok-{ver}-macos-aarch64"), "grok"),
                "darwin-x64" => (format!("grok-{ver}-macos-x86_64"), "grok"),
                "linux-arm64" => (format!("grok-{ver}-linux-aarch64"), "grok"),
                _ => (format!("grok-{ver}-linux-x86_64"), "grok"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://github.com/xai-org/grok-build/releases/download/v{ver}/{file}"),
                archive_kind: "raw_exe",
                exe_name: exe,
            })
        }
        "copilot" => {
            let ver = "1.0.105";
            let (file, kind, exe) = match plat {
                "win32-x64" => ("copilot-win32-x64.zip", "zip", "copilot.exe"),
                "darwin-arm64" => ("copilot-darwin-arm64.tar.gz", "targz", "copilot"),
                "darwin-x64" => ("copilot-darwin-x64.tar.gz", "targz", "copilot"),
                "linux-arm64" => ("copilot-linux-arm64.tar.gz", "targz", "copilot"),
                _ => ("copilot-linux-x64.tar.gz", "targz", "copilot"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://github.com/github/copilot-cli/releases/download/v{ver}/{file}"),
                archive_kind: kind,
                exe_name: exe,
            })
        }
        "cline" => {
            let ver = "3.0.68";
            let (pkg, tgz, exe) = match plat {
                "win32-x64" => ("@cline/cli-windows-x64", format!("cli-windows-x64-{ver}.tgz"), "cline.exe"),
                "darwin-arm64" => ("@cline/cli-darwin-arm64", format!("cli-darwin-arm64-{ver}.tgz"), "cline"),
                "darwin-x64" => ("@cline/cli-darwin-x64", format!("cli-darwin-x64-{ver}.tgz"), "cline"),
                "linux-arm64" => ("@cline/cli-linux-arm64", format!("cli-linux-arm64-{ver}.tgz"), "cline"),
                _ => ("@cline/cli-linux-x64", format!("cli-linux-x64-{ver}.tgz"), "cline"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://registry.npmjs.org/{pkg}/-/{tgz}"),
                archive_kind: "targz",
                exe_name: exe,
            })
        }
        "mistral" => {
            let ver = "3.1.0";
            let (file, kind, exe) = match plat {
                "win32-x64" => (format!("vibe-acp-windows-x86_64-{ver}.zip"), "zip", "vibe-acp.exe"),
                "darwin-arm64" => (format!("vibe-acp-macos-aarch64-{ver}.tar.gz"), "targz", "vibe-acp"),
                "darwin-x64" => (format!("vibe-acp-macos-x86_64-{ver}.tar.gz"), "targz", "vibe-acp"),
                "linux-arm64" => (format!("vibe-acp-linux-aarch64-{ver}.tar.gz"), "targz", "vibe-acp"),
                _ => (format!("vibe-acp-linux-x86_64-{ver}.tar.gz"), "targz", "vibe-acp"),
            };
            Ok(DownloadSpec {
                version: ver,
                url: format!("https://github.com/mistralai/mistral-vibe/releases/download/v{ver}/{file}"),
                archive_kind: kind,
                exe_name: exe,
            })
        }
        _ => Err(format!("Автоустановка для \"{provider}\" не поддерживается — укажите путь к бинарнику вручную")),
    }
}

fn find_executable_recursive(dir: &Path, target_name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_executable_recursive(&p, target_name) {
                return Some(found);
            }
        } else if p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case(target_name))
            .unwrap_or(false)
        {
            return Some(p);
        }
    }
    None
}

fn emit_progress(app: &Option<AppHandle>, provider: &str, status: &str, pct: f64, message: &str) {
    if let Some(h) = app {
        let _ = h.emit(
            "runtime-install-progress",
            RuntimeInstallProgress {
                provider: provider.to_string(),
                status: status.to_string(),
                progress_percent: pct,
                message: message.to_string(),
            },
        );
    }
}

pub async fn install_provider_runtime(
    provider: &str,
    app: Option<AppHandle>,
) -> Result<String, String> {
    let spec = spec_for_provider(provider)?;
    let plat = platform_key();
    let target_root = openbot_app_data_dir()
        .join("OpenBot")
        .join("provider-runtimes")
        .join(provider)
        .join(plat)
        .join(spec.version);
    let bin_dir = target_root.join("bin");
    let staging = target_root.join(".staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    emit_progress(&app, provider, "downloading", 5.0, &format!("Скачивание {} v{}...", provider, spec.version));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&spec.url)
        .header("User-Agent", "AI-Proxy-Desktop/0.1.0")
        .send()
        .await
        .map_err(|e| format!("Ошибка загрузки: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} при загрузке {}", resp.status(), spec.url));
    }

    let total = resp.content_length().unwrap_or(0);
    let archive_path = staging.join("download.tmp");
    let mut out_file = File::create(&archive_path).map_err(|e| e.to_string())?;
    let mut resp = resp;
    let mut downloaded = 0u64;
    let mut last_pct = 0.0f64;

    while let Some(bytes) = resp.chunk().await.map_err(|e| format!("Ошибка потока загрузки: {e}"))? {
        out_file.write_all(&bytes).map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;
        if total > 0 {
            let pct = ((downloaded as f64 / total as f64) * 80.0).min(80.0);
            if pct - last_pct >= 4.0 {
                last_pct = pct;
                emit_progress(
                    &app,
                    provider,
                    "downloading",
                    pct,
                    &format!("Загружено {:.1} МБ...", downloaded as f64 / 1_048_576.0),
                );
            }
        }
    }
    drop(out_file);

    emit_progress(&app, provider, "extracting", 85.0, "Распаковка...");

    let extract_dir = staging.join("extracted");
    fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    if spec.archive_kind == "raw_exe" {
        let dest = bin_dir.join(spec.exe_name);
        fs::copy(&archive_path, &dest).map_err(|e| e.to_string())?;
    } else if spec.archive_kind == "zip" {
        let f = File::open(&archive_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("Ошибка ZIP: {e}"))?;
        archive.extract(&extract_dir).map_err(|e| format!("Ошибка распаковки ZIP: {e}"))?;
    } else {
        let f = File::open(&archive_path).map_err(|e| e.to_string())?;
        let gz = flate2::read::GzDecoder::new(f);
        let mut tar = tar::Archive::new(gz);
        tar.unpack(&extract_dir).map_err(|e| format!("Ошибка распаковки tar.gz: {e}"))?;
    }

    if spec.archive_kind != "raw_exe" {
        if let Some(found_exe) = find_executable_recursive(&extract_dir, spec.exe_name) {
            let parent = found_exe.parent().unwrap_or(&extract_dir);
            // Copy sibling files from the executable's directory (for onedir bundles or sidecar tools)
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let src = entry.path();
                    if src.is_file() {
                        if let Some(name) = src.file_name() {
                            let _ = fs::copy(&src, bin_dir.join(name));
                        }
                    }
                }
            }
        } else {
            return Err(format!("В архиве не найден исполняемый файл {}", spec.exe_name));
        }
    }

    let final_exe = bin_dir.join(spec.exe_name);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if final_exe.exists() {
            let mut perms = fs::metadata(&final_exe).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&final_exe, perms);
        }
    }

    let _ = fs::remove_dir_all(&staging);
    emit_progress(&app, provider, "done", 100.0, &format!("Установлено: {}", final_exe.display()));
    Ok(final_exe.to_string_lossy().to_string())
}

