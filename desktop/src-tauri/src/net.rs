use crate::types::{ExternalProviderConfig, ProxyMode};
use std::time::Duration;

/// Собирает reqwest-клиент с явным прокси (или без него).
/// Пустая строка прокси трактуется как отсутствие прокси.
pub fn build_client(proxy_url: Option<&str>, timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    // Proxy usage is explicit in this application. In particular, "disabled"
    // must mean direct even when Windows/VPN software configures a system proxy.
    let mut builder = reqwest::Client::builder()
        .user_agent("AI-Proxy-Desktop")
        .no_proxy();
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    let trimmed = proxy_url.map(str::trim).filter(|u| !u.is_empty());
    if let Some(url) = trimmed {
        let proxy = reqwest::Proxy::all(url)
            .map_err(|e| format!("Некорректный адрес прокси «{url}»: {e}"))?
            .no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1"));
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("Не удалось создать HTTP-клиент: {e}"))
}

/// Эффективный прокси для конкретного внешнего провайдера:
/// inherit — глобальный из настроек, disabled — напрямую, custom — свой адрес.
pub fn effective_proxy_for<'a>(
    provider: &'a ExternalProviderConfig,
    global: Option<&'a str>,
) -> Option<&'a str> {
    match provider.proxy_mode {
        ProxyMode::Inherit => global.map(str::trim).filter(|u| !u.is_empty()),
        ProxyMode::Disabled => None,
        ProxyMode::Custom => provider.proxy_url.as_deref().map(str::trim).filter(|u| !u.is_empty()),
    }
}

/// Нормализует base_url OpenAI-совместимого API: убирает хвостовые слэши,
/// добавляет /v1 если путь пустой (типичная ошибка при вводе).
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Пустой base URL".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(format!("Base URL должен начинаться с http:// или https://: «{trimmed}»"));
    }
    let without_scheme = trimmed.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    let has_path = without_scheme.contains('/');
    if has_path {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/v1"))
    }
}


/// Эффективный прокси для CLI-провайдера по его ключу:
/// переопределение провайдера (custom/disabled) → глобальный → напрямую.
pub fn resolve_provider_proxy<'a>(
    provider_key: &str,
    overrides: &'a std::collections::HashMap<String, crate::types::ProviderProxyConfig>,
    global: Option<&'a str>,
) -> Option<&'a str> {
    // Точный ключ бэкенда (например antigravity:abc123) имеет приоритет
    // над общим ключом провайдера (antigravity).
    let provider_part = provider_key.split(':').next().unwrap_or(provider_key);
    let cfg = overrides
        .get(provider_key)
        .or_else(|| overrides.get(provider_part));
    match cfg {
        Some(cfg) => match cfg.mode {
            crate::types::ProxyMode::Disabled => None,
            crate::types::ProxyMode::Custom => cfg
                .proxy_url
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .or_else(|| global.map(str::trim).filter(|u| !u.is_empty())),
            crate::types::ProxyMode::Inherit => global.map(str::trim).filter(|u| !u.is_empty()),
        },
        None => global.map(str::trim).filter(|u| !u.is_empty()),
    }
}

/// Проставляет HTTP(S)_PROXY дочернему процессу, если задан глобальный прокси
/// и пользователь не переопределил эти переменные явно в конфиге бэкенда.
/// Локальные адреса всегда идут напрямую через NO_PROXY.
pub fn apply_proxy_env(
    cmd: &mut tokio::process::Command,
    proxy_url: Option<&str>,
    env_overrides: &std::collections::HashMap<String, Option<String>>,
) {
    let Some(url) = proxy_url.map(str::trim).filter(|u| !u.is_empty()) else {
        return;
    };
    let overridden = |name: &str| {
        env_overrides.keys().any(|k| k.eq_ignore_ascii_case(name))
    };
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        if !overridden(key) {
            cmd.env(key, url);
        }
    }
    if !overridden("NO_PROXY") {
        cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");
        cmd.env("no_proxy", "localhost,127.0.0.1,::1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(normalize_base_url("https://api.openai.com").unwrap(), "https://api.openai.com/v1");
        assert_eq!(
            normalize_base_url("https://openrouter.ai/api/v1/").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_base_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1"
        );
        assert!(normalize_base_url("api.openai.com").is_err());
        assert!(normalize_base_url("  ").is_err());
    }

    fn proxy_cfg(mode: crate::types::ProxyMode, url: Option<&str>) -> crate::types::ProviderProxyConfig {
        crate::types::ProviderProxyConfig {
            mode,
            proxy_url: url.map(str::to_string),
        }
    }

    #[test]
    fn provider_proxy_resolution_priority_chain() {
        use crate::types::ProxyMode;
        let global = Some("http://global:8080");
        let empty: std::collections::HashMap<String, crate::types::ProviderProxyConfig> = Default::default();

        // No override at all -> global
        assert_eq!(resolve_provider_proxy("devin", &empty, global), global);
        // No override and no global -> direct
        assert_eq!(resolve_provider_proxy("devin", &empty, None), None);
        assert_eq!(resolve_provider_proxy("devin", &empty, Some("  ")), None);

        let mut overrides: std::collections::HashMap<String, crate::types::ProviderProxyConfig> = Default::default();
        // Inherit explicitly -> still global
        overrides.insert("devin".into(), proxy_cfg(ProxyMode::Inherit, None));
        assert_eq!(resolve_provider_proxy("devin", &overrides, global), global);

        // Disabled beats global
        overrides.insert("devin".into(), proxy_cfg(ProxyMode::Disabled, None));
        assert_eq!(resolve_provider_proxy("devin", &overrides, global), None);

        // Custom beats global
        overrides.insert("devin".into(), proxy_cfg(ProxyMode::Custom, Some("http://custom:1080")));
        assert_eq!(resolve_provider_proxy("devin", &overrides, global), Some("http://custom:1080"));

        // Custom with a blank url is an incomplete override, not intent to go direct:
        // fall back to global rather than silently bypassing it.
        overrides.insert("devin".into(), proxy_cfg(ProxyMode::Custom, Some("   ")));
        assert_eq!(resolve_provider_proxy("devin", &overrides, global), global);

        // Exact account-scoped key beats the provider-wide key
        overrides.insert("antigravity".into(), proxy_cfg(ProxyMode::Custom, Some("http://provider:1")));
        overrides.insert("antigravity:acc1".into(), proxy_cfg(ProxyMode::Custom, Some("http://account:2")));
        assert_eq!(
            resolve_provider_proxy("antigravity:acc1", &overrides, global),
            Some("http://account:2")
        );
        // Sibling account without its own override uses the provider-wide one
        assert_eq!(
            resolve_provider_proxy("antigravity:acc2", &overrides, global),
            Some("http://provider:1")
        );
    }
}
