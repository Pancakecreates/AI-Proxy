use crate::types::{ExternalProviderConfig, ProxyMode};
use std::time::Duration;

/// Собирает reqwest-клиент с явным прокси (или без него).
/// Пустая строка прокси трактуется как отсутствие прокси.
pub fn build_client(proxy_url: Option<&str>, timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent("AI-Proxy-Desktop");
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    let trimmed = proxy_url.map(str::trim).filter(|u| !u.is_empty());
    if let Some(url) = trimmed {
        let proxy = reqwest::Proxy::all(url)
            .map_err(|e| format!("Некорректный адрес прокси «{url}»: {e}"))?;
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
    let without_scheme = trimmed.splitn(2, "://").nth(1).unwrap_or("");
    let has_path = without_scheme.contains('/');
    if has_path {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/v1"))
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
}
