use crate::types::{AntigravityAccountConfig, AppSettings, DetectedRuntimes};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

fn simplify_unc_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}


pub fn openbot_app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.trim().is_empty() {
                return PathBuf::from(appdata);
            }
        }
    }
    dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn app_managed_accounts_dir() -> PathBuf {
    openbot_app_data_dir()
        .join("OpenBot")
        .join("provider-accounts")
}

fn openbot_platform_dir() -> &'static str {
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

pub fn resolve_runtime_executable(
    runtime_name: &str,
    base_exe_names: &[&str],
    explicit: Option<&str>,
) -> Option<String> {
    if let Some(cand) = explicit {
        let trimmed = cand.trim();
        if !trimmed.is_empty() && Path::new(trimmed).exists() {
            return Some(trimmed.to_string());
        }
    }

    let runtime_root = openbot_app_data_dir()
        .join("OpenBot")
        .join("provider-runtimes")
        .join(runtime_name)
        .join(openbot_platform_dir());

    if runtime_root.exists() {
        if let Ok(entries) = fs::read_dir(&runtime_root) {
            let mut versions: Vec<String> = entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| !name.starts_with('.'))
                .collect();
            versions.sort_by(|a, b| b.cmp(a));
            for ver in versions {
                for base in base_exe_names {
                    let candidates: Vec<String> = if cfg!(target_os = "windows") {
                        vec![format!("{base}.exe"), format!("{base}.cmd"), base.to_string()]
                    } else {
                        vec![base.to_string()]
                    };
                    for exe_name in candidates {
                        let candidate = runtime_root.join(&ver).join("bin").join(&exe_name);
                        if candidate.exists() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }

    for base in base_exe_names {
        let lookup = if cfg!(target_os = "windows") {
            format!("{base}.exe")
        } else {
            base.to_string()
        };
        if let Ok(p) = which::which(&lookup) {
            return Some(p.to_string_lossy().to_string());
        }
        if let Ok(p) = which::which(base) {
            return Some(p.to_string_lossy().to_string());
        }
    }

    None
}

pub fn read_antigravity_account_email(app_data_path: &Path) -> Option<String> {
    let token_file = app_data_path.join("antigravity-oauth-token");
    let raw = fs::read_to_string(token_file).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let email = parsed.get("id_token_email")?.as_str()?.trim();
    if email.is_empty() {
        None
    } else {
        Some(email.to_string())
    }
}

fn make_short_account_id(preferred: &str, used: &mut HashSet<String>, fallback_index: usize) -> String {
    let clean: String = preferred
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(10)
        .collect();
    let base = if clean.is_empty() {
        format!("acc{fallback_index}")
    } else {
        clean
    };
    let mut id = base.clone();
    let mut n = 2usize;
    while used.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    used.insert(id.clone());
    id
}

pub fn discover_antigravity_accounts() -> Vec<AntigravityAccountConfig> {
    let mut discovered = Vec::new();
    let mut seen_dirs = HashSet::new();
    let mut used_ids = HashSet::new();
    let default_app_data = "antigravity-acp";

    let mut push_account = |gemini_dir: PathBuf, preferred_id: &str, managed: bool| {
        let canonical = fs::canonicalize(&gemini_dir).unwrap_or_else(|_| gemini_dir.clone());
        let key = canonical.to_string_lossy().to_lowercase();
        if seen_dirs.contains(&key) {
            return;
        }
        let app_data_path = canonical.join(default_app_data);
        if !app_data_path.exists() {
            return;
        }
        seen_dirs.insert(key);
        let email = read_antigravity_account_email(&app_data_path);
        let id = make_short_account_id(preferred_id, &mut used_ids, discovered.len() + 1);
        let label = email
            .clone()
            .unwrap_or_else(|| format!("Account {} ({})", discovered.len() + 1, id));
        discovered.push(AntigravityAccountConfig {
            id,
            label,
            gemini_dir: simplify_unc_path(&canonical),
            app_data_dir: default_app_data.to_string(),
            email,
            enabled: true,
            managed,
        });
    };

    if let Some(home) = dirs::home_dir() {
        push_account(home.join(".gemini"), "primary", false);
    }

    let accounts_root = app_managed_accounts_dir();
    if accounts_root.exists() {
        if let Ok(entries) = fs::read_dir(&accounts_root) {
            let mut dirs_list: Vec<String> = entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| !name.starts_with('.'))
                .collect();
            dirs_list.sort();
            for dir_name in dirs_list {
                push_account(accounts_root.join(&dir_name), &dir_name, false);
            }
        }
    }

    discovered
}

pub fn merge_antigravity_accounts(saved: &[AntigravityAccountConfig]) -> Vec<AntigravityAccountConfig> {
    let disk = discover_antigravity_accounts();
    let mut result = Vec::new();
    let mut seen_dirs = HashSet::new();

    for acc in saved {
        let canon = fs::canonicalize(&acc.gemini_dir)
            .unwrap_or_else(|_| PathBuf::from(&acc.gemini_dir));
        let norm = simplify_unc_path(&canon).to_lowercase();
        seen_dirs.insert(norm);
        let fresh_email = read_antigravity_account_email(
            &Path::new(&acc.gemini_dir).join(&acc.app_data_dir),
        );
        let mut updated = acc.clone();
        updated.gemini_dir = simplify_unc_path(Path::new(&updated.gemini_dir));
        if let Some(em) = fresh_email {
            updated.email = Some(em.clone());
            if updated.label.starts_with("Account ") || updated.label.starts_with("New Account") {
                updated.label = em;
            }
        }
        result.push(updated);
    }

    for d in disk {
        let norm = simplify_unc_path(std::path::Path::new(&d.gemini_dir)).to_lowercase();
        if !seen_dirs.contains(&norm) {
            seen_dirs.insert(norm);
            result.push(d);
        }
    }

    result
}

pub fn detect_all_runtimes(settings: &AppSettings) -> DetectedRuntimes {
    DetectedRuntimes {
        devin_path: resolve_runtime_executable("devin", &["devin"], settings.devin_path.as_deref()),
        antigravity_path: resolve_runtime_executable("antigravity", &["antigravity"], settings.antigravity_path.as_deref()),
        opencode_path: resolve_runtime_executable("opencode", &["opencode"], settings.opencode_path.as_deref()),
        grok_path: resolve_runtime_executable("grok", &["grok"], settings.grok_path.as_deref()),
        codex_path: resolve_runtime_executable("codex", &["codex"], settings.codex_path.as_deref()),
        copilot_path: resolve_runtime_executable("copilot", &["copilot"], settings.copilot_path.as_deref()),
        cursor_path: resolve_runtime_executable("cursor", &["cursor-agent", "agent"], settings.cursor_path.as_deref()),
        cline_path: resolve_runtime_executable("cline", &["cline"], settings.cline_path.as_deref()),
        mistral_path: resolve_runtime_executable("mistral", &["vibe-acp", "vibe"], settings.mistral_path.as_deref()),
        kimi_path: resolve_runtime_executable("kimi", &["kimi"], settings.kimi_path.as_deref()),
        hermes_path: resolve_runtime_executable("hermes", &["hermes"], settings.hermes_path.as_deref()),
        antigravity_accounts: merge_antigravity_accounts(&settings.antigravity_accounts),
    }
}

#[cfg(test)]
mod tests {
    use super::simplify_unc_path;
    use std::path::Path;

    #[test]
    fn strips_windows_extended_length_prefix() {
        assert_eq!(
            simplify_unc_path(Path::new(r"\\?\C:\Users\Admin\.gemini")),
            r"C:\Users\Admin\.gemini"
        );
        assert_eq!(
            simplify_unc_path(Path::new(r"\\?\UNC\server\share\x")),
            r"\\server\share\x"
        );
        assert_eq!(
            simplify_unc_path(Path::new(r"C:\Users\Admin\.gemini")),
            r"C:\Users\Admin\.gemini"
        );
    }
}
