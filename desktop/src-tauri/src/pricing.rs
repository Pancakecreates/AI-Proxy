use crate::types::{AppSettings, BackendKind, ModelPricing};

pub fn default_api_pricing(model_id: &str) -> ModelPricing {
    let lower = model_id.to_lowercase();
    if lower.contains("opus") {
        ModelPricing { input_per_1m_usd: 15.0, output_per_1m_usd: 75.0, billable: false }
    } else if lower.contains("sonnet") || lower.contains("fable") || lower.contains("mythos") {
        ModelPricing { input_per_1m_usd: 3.0, output_per_1m_usd: 15.0, billable: false }
    } else if lower.contains("haiku") {
        ModelPricing { input_per_1m_usd: 0.8, output_per_1m_usd: 4.0, billable: false }
    } else if lower.contains("gemini-4-neon") || lower.contains("gemini-4-carbon") || lower.contains("pro") {
        ModelPricing { input_per_1m_usd: 1.25, output_per_1m_usd: 10.0, billable: false }
    } else if lower.contains("gemini") || lower.contains("flash") {
        ModelPricing { input_per_1m_usd: 0.15, output_per_1m_usd: 0.60, billable: false }
    } else if lower.contains("gpt-5") || lower.contains("gpt-6") || lower.contains("codex") {
        ModelPricing { input_per_1m_usd: 2.0, output_per_1m_usd: 8.0, billable: false }
    } else if lower.contains("grok") {
        ModelPricing { input_per_1m_usd: 3.0, output_per_1m_usd: 15.0, billable: false }
    } else if lower.contains("deepseek") {
        ModelPricing { input_per_1m_usd: 0.55, output_per_1m_usd: 2.19, billable: false }
    } else if lower.contains("kimi") || lower.contains("glm") || lower.contains("qwen") || lower.contains("minimax") {
        ModelPricing { input_per_1m_usd: 0.50, output_per_1m_usd: 2.0, billable: false }
    } else {
        ModelPricing { input_per_1m_usd: 1.50, output_per_1m_usd: 6.0, billable: false }
    }
}

pub fn calculate_costs(
    settings: &AppSettings,
    backend_kind: BackendKind,
    native_model_id: &str,
    input_tokens: u64,
    output_tokens: u64,
) -> (f64, f64) {
    let pricing = settings
        .custom_pricing
        .get(native_model_id)
        .cloned()
        .unwrap_or_else(|| default_api_pricing(native_model_id));

    let eq_usd = (input_tokens as f64 / 1_000_000.0) * pricing.input_per_1m_usd
        + (output_tokens as f64 / 1_000_000.0) * pricing.output_per_1m_usd;

    let pay_per_token = pricing.billable
        || (backend_kind == BackendKind::Grok
            && settings.xai_api_key.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false));

    let cost_usd = if pay_per_token { eq_usd } else { 0.0 };
    (round_usd(cost_usd), round_usd(eq_usd))
}

fn round_usd(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

pub fn estimate_tokens_from_chars(chars: usize) -> u64 {
    if chars == 0 {
        return 0;
    }
    ((chars as f64) / 3.5).ceil().max(1.0) as u64
}
