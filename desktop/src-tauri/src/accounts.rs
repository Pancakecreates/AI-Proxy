use crate::discovery::merge_antigravity_accounts;
use crate::types::{AppSettings, ProviderAccountConfig};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn legacy_antigravity_as_provider_accounts(settings: &AppSettings) -> Vec<ProviderAccountConfig> {
    merge_antigravity_accounts(&settings.antigravity_accounts)
        .into_iter()
        .map(|acc| ProviderAccountConfig {
            id: acc.id,
            label: acc.label,
            profile_dir: acc.gemini_dir,
            app_data_dir: Some(acc.app_data_dir),
            email: acc.email,
            enabled: acc.enabled,
            managed: acc.managed,
        })
        .collect()
}

pub fn accounts_for_provider(settings: &AppSettings, provider: &str) -> Vec<ProviderAccountConfig> {
    let mut out = settings
        .provider_accounts
        .get(provider)
        .cloned()
        .unwrap_or_default();

    if provider == "antigravity" {
        for legacy in legacy_antigravity_as_provider_accounts(settings) {
            let duplicate = out.iter().any(|a| {
                a.id == legacy.id
                    || Path::new(&a.profile_dir)
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&legacy.profile_dir)
            });
            if !duplicate {
                out.push(legacy);
            }
        }
    }
    out
}

pub fn account_backend_key(provider: &str, account: Option<&ProviderAccountConfig>) -> String {
    account
        .map(|a| format!("{provider}:{}", a.id))
        .unwrap_or_else(|| provider.to_string())
}

pub fn account_backend_label(provider_label: &str, index: usize, account: Option<&ProviderAccountConfig>) -> String {
    match account {
        Some(acc) => format!("{provider_label} {} ({})", index + 1, acc.label),
        None => provider_label.to_string(),
    }
}

pub fn account_model_prefix(provider: &str, account: Option<&ProviderAccountConfig>, single_prefix: &str) -> String {
    match account {
        Some(acc) => format!("{}-{}.", provider, acc.id.replace('_', "-")),
        None => single_prefix.to_string(),
    }
}

fn insert_env(env: &mut HashMap<String, Option<String>>, key: &str, value: impl Into<String>) {
    env.insert(key.to_string(), Some(value.into()));
}

fn insert_home_isolation(env: &mut HashMap<String, Option<String>>, profile_dir: &Path) {
    let home = profile_dir.join("home");
    insert_env(env, "HOME", home.to_string_lossy().to_string());
    insert_env(env, "USERPROFILE", home.to_string_lossy().to_string());
    insert_env(env, "APPDATA", profile_dir.join("appdata").to_string_lossy().to_string());
    insert_env(env, "LOCALAPPDATA", profile_dir.join("local-appdata").to_string_lossy().to_string());
    insert_env(env, "XDG_CONFIG_HOME", profile_dir.join("xdg-config").to_string_lossy().to_string());
    insert_env(env, "XDG_DATA_HOME", profile_dir.join("xdg-data").to_string_lossy().to_string());
    insert_env(env, "XDG_CACHE_HOME", profile_dir.join("xdg-cache").to_string_lossy().to_string());
}

/// Переменные окружения, которые дают CLI отдельное домашнее состояние для аккаунта.
/// Для провайдеров с documented profile/home override используем его; для CLI без
/// такого override изолируем стандартные home/config/data locations процесса.
pub fn profile_env_overrides(provider: &str, account: &ProviderAccountConfig) -> HashMap<String, Option<String>> {
    let mut env = HashMap::new();
    let profile = PathBuf::from(&account.profile_dir);
    let profile_s = profile.to_string_lossy().to_string();

    match provider {
        "codex" => insert_env(&mut env, "CODEX_HOME", profile_s),
        "grok" => insert_env(&mut env, "GROK_HOME", profile_s),
        "copilot" => insert_env(&mut env, "COPILOT_HOME", profile_s),
        "mistral" => insert_env(&mut env, "VIBE_HOME", profile_s),
        "kimi" => insert_env(&mut env, "KIMI_CODE_HOME", profile_s),
        "hermes" => insert_env(&mut env, "HERMES_HOME", profile_s),
        "opencode" => {
            insert_env(&mut env, "OPENCODE_DB", profile.join("opencode.db").to_string_lossy().to_string());
            insert_env(&mut env, "XDG_DATA_HOME", profile.join("xdg-data").to_string_lossy().to_string());
        }
        "devin" => {
            insert_env(&mut env, "XDG_DATA_HOME", profile.join("xdg-data").to_string_lossy().to_string());
            #[cfg(target_os = "windows")]
            insert_env(&mut env, "APPDATA", profile.join("appdata").to_string_lossy().to_string());
        }
        "cline" | "cursor" => insert_home_isolation(&mut env, &profile),
        _ => {}
    }
    env
}

pub fn prepare_profile_dirs(provider: &str, account: &ProviderAccountConfig) -> Result<(), String> {
    let profile = PathBuf::from(&account.profile_dir);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    for child in ["home", "appdata", "local-appdata", "xdg-config", "xdg-data", "xdg-cache"] {
        std::fs::create_dir_all(profile.join(child)).map_err(|e| e.to_string())?;
    }
    if provider == "antigravity" {
        if let Some(app_data) = account.app_data_dir.as_deref().filter(|s| !s.trim().is_empty()) {
            std::fs::create_dir_all(profile.join(app_data)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn env_as_slices(env: &HashMap<String, Option<String>>) -> Vec<(&str, &str)> {
    env.iter()
        .filter_map(|(k, v)| v.as_deref().map(|value| (k.as_str(), value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_profile_envs_cover_main_providers() {
        let acc = ProviderAccountConfig {
            id: "work".into(),
            label: "Work".into(),
            profile_dir: if cfg!(windows) { r"C:\profiles\work".into() } else { "/tmp/work".into() },
            app_data_dir: None,
            email: None,
            enabled: true,
            managed: true,
        };
        for (provider, key) in [
            ("codex", "CODEX_HOME"),
            ("grok", "GROK_HOME"),
            ("copilot", "COPILOT_HOME"),
            ("mistral", "VIBE_HOME"),
            ("kimi", "KIMI_CODE_HOME"),
            ("hermes", "HERMES_HOME"),
        ] {
            let env = profile_env_overrides(provider, &acc);
            assert_eq!(env.get(key).and_then(|v| v.as_deref()), Some(acc.profile_dir.as_str()));
        }
        let env = profile_env_overrides("opencode", &acc);
        assert!(env.get("OPENCODE_DB").and_then(|v| v.as_deref()).unwrap().ends_with("opencode.db"));
    }
}
