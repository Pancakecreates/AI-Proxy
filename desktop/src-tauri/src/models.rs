use crate::types::{
    BackendKind, BackendModelEntry, OpenCodeFilterMode, RawModelEntry, SpeedMode, ThoughtConfigId,
    ThoughtLevel,
};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const CREATED_AT_ISO: &str = "2026-01-01T00:00:00Z";
const GATEWAY_ALIAS_PREFIX: &str = "claude-fable-acp-";
const GATEWAY_SAFE_HEX_PREFIX: &str = "h-";
const SAFE_HEX_ALPHABET: &[u8; 16] = b"0123456789cfjquw";

fn non_anthropic_blocklist_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk")
            .expect("valid blocklist regex")
    })
}

fn gateway_tier_exact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$").expect("valid tier regex"))
}

fn claude_tier_display_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(opus|sonnet|haiku|fable|mythos)\b").expect("valid tier display regex"))
}

fn effort_suffix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)-(none|minimal|low|medium|high|xhigh|max)$").expect("valid effort suffix regex"))
}

fn speed_suffix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)-(lightning|ultrafast|fast)$").expect("valid speed suffix regex"))
}

pub fn normalize_tier_display_name(name: &str) -> String {
    if claude_tier_display_re().is_match(name) && !name.to_lowercase().starts_with("claude") {
        format!("Claude {name}")
    } else {
        name.to_string()
    }
}

pub fn is_free_opencode_model(id: &str, name: &str) -> bool {
    let norm_id = id.trim().to_lowercase();
    if norm_id == "opencode/big-pickle" || norm_id.ends_with("-free") {
        return true;
    }
    let norm_name = name.trim().to_lowercase();
    norm_name == "free" || norm_name.ends_with(" free")
}

pub fn filter_opencode_models(
    models: &[RawModelEntry],
    mode: OpenCodeFilterMode,
    custom_providers: &[String],
) -> Vec<RawModelEntry> {
    match mode {
        OpenCodeFilterMode::All => models.to_vec(),
        OpenCodeFilterMode::Custom if !custom_providers.is_empty() => {
            let prefixes: Vec<String> = custom_providers
                .iter()
                .map(|p| p.trim().to_lowercase())
                .filter(|p| !p.is_empty())
                .collect();
            models
                .iter()
                .filter(|m| {
                    let lower = m.id.to_lowercase();
                    prefixes.iter().any(|prefix| {
                        if prefix.ends_with('/') {
                            lower.starts_with(prefix)
                        } else {
                            lower.starts_with(&format!("{prefix}/")) || lower == *prefix
                        }
                    })
                })
                .cloned()
                .collect()
        }
        _ => models
            .iter()
            .filter(|m| {
                let lower = m.id.to_lowercase();
                lower.starts_with("opencode-go/")
                    || (lower.starts_with("opencode/") && is_free_opencode_model(&m.id, &m.name))
            })
            .cloned()
            .collect(),
    }
}

pub fn is_claude_desktop_compatible_id(id: &str) -> bool {
    let lower = id.trim().to_lowercase();
    if lower.is_empty() || non_anthropic_blocklist_re().is_match(&lower) {
        return false;
    }
    if gateway_tier_exact_re().is_match(&lower) {
        return true;
    }
    ["claude", "sonnet", "opus", "haiku", "fable", "mythos", "anthropic"]
        .iter()
        .any(|kw| lower.contains(kw))
}

fn encode_safe_hex(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.as_bytes() {
        out.push(SAFE_HEX_ALPHABET[((byte >> 4) & 0x0f) as usize] as char);
        out.push(SAFE_HEX_ALPHABET[(byte & 0x0f) as usize] as char);
    }
    out
}

fn decode_safe_hex(encoded: &str) -> Option<String> {
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return None;
    }
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(encoded.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = SAFE_HEX_ALPHABET.iter().position(|&c| c == pair[0])?;
        let lo = SAFE_HEX_ALPHABET.iter().position(|&c| c == pair[1])?;
        out.push(((hi << 4) | lo) as u8);
    }
    String::from_utf8(out).ok()
}

pub fn to_gateway_model_id(native_id: &str, force_alias: bool) -> String {
    if !force_alias && is_claude_desktop_compatible_id(native_id) {
        return native_id.to_string();
    }

    let valid_chars = !native_id.is_empty()
        && !native_id.contains("--")
        && native_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'));

    if valid_chars {
        let mut body = native_id.to_string();
        for _ in 0..32 {
            if !non_anthropic_blocklist_re().is_match(&body) {
                break;
            }
            let next = non_anthropic_blocklist_re()
                .replace(&body, |caps: &regex::Captures| {
                    let m = &caps[0];
                    let mut chars = m.chars();
                    let first = chars.next().unwrap_or_default();
                    let rest: String = chars.collect();
                    format!("{first}--{rest}")
                })
                .to_string();
            if next == body {
                break;
            }
            body = next;
        }

        let readable = format!("{GATEWAY_ALIAS_PREFIX}{body}");
        if readable.len() <= 245
            && !body.starts_with(GATEWAY_SAFE_HEX_PREFIX)
            && is_claude_desktop_compatible_id(&readable)
            && decode_gateway_model_id(&readable).as_deref() == Some(native_id)
        {
            return readable;
        }
    }

    format!(
        "{GATEWAY_ALIAS_PREFIX}{GATEWAY_SAFE_HEX_PREFIX}{}",
        encode_safe_hex(native_id)
    )
}

pub fn decode_gateway_model_id(id: &str) -> Option<String> {
    let trimmed = id.trim();
    if !trimmed.to_lowercase().starts_with(GATEWAY_ALIAS_PREFIX) {
        return None;
    }
    let body = &trimmed[GATEWAY_ALIAS_PREFIX.len()..];
    if body.is_empty() {
        return None;
    }
    if body.to_lowercase().starts_with(GATEWAY_SAFE_HEX_PREFIX) {
        return decode_safe_hex(&body[GATEWAY_SAFE_HEX_PREFIX.len()..].to_lowercase());
    }
    Some(body.replace("--", ""))
}

pub fn normalize_effort_value(raw: Option<&str>) -> Option<ThoughtLevel> {
    let norm = raw?.trim().to_lowercase().replace('-', "_");
    match norm.as_str() {
        "none" | "off" => Some(ThoughtLevel::None),
        "minimal" => Some(ThoughtLevel::Minimal),
        "low" => Some(ThoughtLevel::Low),
        "medium" => Some(ThoughtLevel::Medium),
        "high" | "on" => Some(ThoughtLevel::High),
        "xhigh" | "extra" | "extra_high" | "very_high" => Some(ThoughtLevel::Xhigh),
        "max" | "ultra" => Some(ThoughtLevel::Max),
        _ => None,
    }
}

pub fn fit_supported_effort(
    desired: Option<ThoughtLevel>,
    supported: &[ThoughtLevel],
) -> Option<ThoughtLevel> {
    let desired = desired?;
    if supported.is_empty() || supported.contains(&desired) {
        return Some(desired);
    }
    let desired_idx = ThoughtLevel::SCALE.iter().position(|&v| v == desired)? as isize;
    let mut best: Option<ThoughtLevel> = None;
    let mut best_dist = isize::MAX;
    let mut best_idx = -1isize;

    for &cand in supported {
        let Some(idx) = ThoughtLevel::SCALE.iter().position(|&v| v == cand) else {
            continue;
        };
        let idx = idx as isize;
        let dist = (idx - desired_idx).abs();
        if dist < best_dist || (dist == best_dist && idx > best_idx) {
            best = Some(cand);
            best_dist = dist;
            best_idx = idx;
        }
    }
    best.or_else(|| supported.first().copied())
}

pub fn resolve_thought_level(
    requested_effort: Option<ThoughtLevel>,
    output_config_effort: Option<&str>,
    thinking_disabled: bool,
    thinking_budget: Option<u64>,
    default_level: Option<ThoughtLevel>,
    supported: &[ThoughtLevel],
) -> Option<ThoughtLevel> {
    let mut desired = requested_effort.or_else(|| normalize_effort_value(output_config_effort));

    if desired.is_none() {
        if thinking_disabled {
            desired = Some(ThoughtLevel::None);
        } else if let Some(budget) = thinking_budget {
            desired = Some(if budget < 2_048 {
                ThoughtLevel::Low
            } else if budget < 8_192 {
                ThoughtLevel::Medium
            } else if budget < 16_000 {
                ThoughtLevel::High
            } else if budget < 32_000 {
                ThoughtLevel::Xhigh
            } else {
                ThoughtLevel::Max
            });
        }
    }

    if desired.is_none() {
        desired = default_level;
    }

    fit_supported_effort(desired, supported)
}

pub fn resolve_speed(
    requested: Option<SpeedMode>,
    default_speed: Option<SpeedMode>,
    supported: &[SpeedMode],
) -> Option<SpeedMode> {
    let desired = requested.or(default_speed)?;
    if supported.is_empty() {
        return None;
    }
    if supported.contains(&desired) {
        return Some(desired);
    }
    if desired == SpeedMode::Fast && supported.contains(&SpeedMode::Ultrafast) {
        return Some(SpeedMode::Ultrafast);
    }
    if desired == SpeedMode::Ultrafast && supported.contains(&SpeedMode::Fast) {
        return Some(SpeedMode::Fast);
    }
    None
}

pub fn peel_effort_and_speed_suffixes(slug: &str) -> (String, Option<ThoughtLevel>, Option<SpeedMode>) {
    let mut base = slug.to_string();
    let mut speed = None;
    let mut effort = None;

    if let Some(m) = speed_suffix_re().find(&base) {
        let token = m.as_str()[1..].to_lowercase();
        speed = Some(if token == "fast" { SpeedMode::Fast } else { SpeedMode::Ultrafast });
        base.truncate(m.start());
    }

    if let Some(m) = effort_suffix_re().find(&base) {
        effort = normalize_effort_value(Some(&m.as_str()[1..]));
        base.truncate(m.start());
    }

    (base, effort, speed)
}

pub fn infer_model_line(id: &str) -> Option<&'static str> {
    let lower = id.to_lowercase();
    if lower.contains("opus") {
        Some("opus")
    } else if lower.contains("sonnet") {
        Some("sonnet")
    } else if lower.contains("haiku") {
        Some("haiku")
    } else if lower.contains("fable") {
        Some("fable")
    } else {
        None
    }
}

pub fn infer_max_input_tokens(id: &str) -> u64 {
    let lower = id.to_lowercase();
    if lower.ends_with("-1m")
        || lower.contains("gemini")
        || lower.contains("deepseek")
        || lower.contains("claude-fable")
        || lower.contains("claude-opus-5")
        || lower.contains("claude-sonnet-5")
    {
        1_000_000
    } else if lower.contains("gpt-") || lower.contains("codex") || lower.contains("grok") {
        400_000
    } else {
        262_144
    }
}

pub fn infer_model_brand(id: &str, backend_kind: BackendKind) -> &'static str {
    let lower = id.to_lowercase();
    if lower.contains("claude") || lower.contains("opus") || lower.contains("sonnet") || lower.contains("haiku") || lower.contains("fable") || lower.contains("mythos") {
        "claude"
    } else if lower.contains("gemini") || lower.contains("gemma") || backend_kind == BackendKind::Antigravity {
        "gemini"
    } else if lower.contains("gpt") || lower.contains("codex") || lower.contains("o1") || lower.contains("o3") || lower.contains("o4") || backend_kind == BackendKind::Codex {
        "openai"
    } else if lower.contains("grok") || backend_kind == BackendKind::Grok {
        "grok"
    } else if lower.contains("deepseek") {
        "deepseek"
    } else if lower.contains("mistral") || lower.contains("mixtral") || lower.contains("devstral") || lower.contains("ministral") || backend_kind == BackendKind::Mistral {
        "mistral"
    } else if lower.contains("llama") || lower.contains("meta") {
        "meta"
    } else if lower.contains("qwen") {
        "qwen"
    } else if lower.contains("cohere") || lower.contains("command-r") {
        "cohere"
    } else if lower.contains("nemotron") || lower.contains("nvidia") {
        "nvidia"
    } else if lower.contains("sonar") || lower.contains("perplexity") {
        "perplexity"
    } else if lower.contains("swe") {
        "devin"
    } else if backend_kind == BackendKind::Opencode {
        "opencode"
    } else if backend_kind == BackendKind::Copilot {
        "copilot"
    } else if backend_kind == BackendKind::Cursor {
        "cursor"
    } else if backend_kind == BackendKind::Cline {
        "cline"
    } else if backend_kind == BackendKind::Kimi || lower.contains("kimi") {
        "kimi"
    } else if backend_kind == BackendKind::Hermes || lower.contains("hermes") {
        "hermes"
    } else {
        "devin"
    }
}

#[derive(Debug, Clone)]
pub struct ParsedConfigCatalog {
    pub models: Vec<RawModelEntry>,
    pub modes: Vec<String>,
    pub thought_levels: Vec<ThoughtLevel>,
    pub thought_config_id: Option<ThoughtConfigId>,
    pub thought_wire_values: HashMap<ThoughtLevel, String>,
    pub speeds: Vec<SpeedMode>,
    pub current_model: Option<String>,
    pub current_mode: Option<String>,
    pub current_thought_level: Option<ThoughtLevel>,
    pub current_speed: Option<SpeedMode>,
}

fn flatten_select_options(options: Option<&Value>) -> Vec<&Value> {
    let mut flat = Vec::new();
    let Some(arr) = options.and_then(|v| v.as_array()) else {
        return flat;
    };
    for entry in arr {
        if let Some(nested) = entry.get("options").and_then(|v| v.as_array()) {
            for item in nested {
                if item.get("value").and_then(|v| v.as_str()).is_some() {
                    flat.push(item);
                }
            }
        } else if entry.get("value").and_then(|v| v.as_str()).is_some() {
            flat.push(entry);
        }
    }
    flat
}

pub fn parse_config_catalog(config_options: Option<&Value>, fallback_models: Option<&Value>) -> ParsedConfigCatalog {
    let mut catalog = ParsedConfigCatalog {
        models: Vec::new(),
        modes: Vec::new(),
        thought_levels: Vec::new(),
        thought_config_id: None,
        thought_wire_values: HashMap::new(),
        speeds: Vec::new(),
        current_model: None,
        current_mode: None,
        current_thought_level: None,
        current_speed: None,
    };

    if let Some(opts) = config_options.and_then(|v| v.as_array()) {
        for option in opts {
            let id = option.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let category = option.get("category").and_then(|v| v.as_str()).unwrap_or("");
            let current = option.get("currentValue").and_then(|v| v.as_str()).map(|s| s.to_string());
            let entries = flatten_select_options(option.get("options"));

            if id == "model" {
                catalog.current_model = current;
                catalog.models = entries
                    .into_iter()
                    .filter_map(|e| {
                        let val = e.get("value")?.as_str()?.to_string();
                        let display_name = normalize_tier_display_name(e.get("name").and_then(|v| v.as_str()).unwrap_or(&val));
                        let supports_images = e
                            .get("_meta")
                            .and_then(|m| m.get("cognition.ai/supportsImages"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        let desc = e.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                        Some(RawModelEntry {
                            id: val,
                            name: display_name,
                            supports_images,
                            description: desc,
                            supported_efforts: Vec::new(),
                            effort_wire_values: HashMap::new(),
                            default_effort: None,
                            supported_speeds: Vec::new(),
                        })
                    })
                    .collect();
            } else if id == "mode" {
                catalog.current_mode = current;
                catalog.modes = entries
                    .into_iter()
                    .filter_map(|e| e.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect();
            } else if id == "speed" {
                catalog.current_speed = current.as_deref().and_then(|s| match s {
                    "standard" => Some(SpeedMode::Standard),
                    "fast" => Some(SpeedMode::Fast),
                    "ultrafast" => Some(SpeedMode::Ultrafast),
                    _ => None,
                });
                catalog.speeds = entries
                    .into_iter()
                    .filter_map(|e| match e.get("value").and_then(|v| v.as_str())? {
                        "standard" => Some(SpeedMode::Standard),
                        "fast" => Some(SpeedMode::Fast),
                        "ultrafast" => Some(SpeedMode::Ultrafast),
                        _ => None,
                    })
                    .collect();
            } else if id == "thought_level" || id == "effort" || id == "reasoning_effort" || category == "thought_level" {
                catalog.thought_config_id = Some(match id {
                    "effort" => ThoughtConfigId::Effort,
                    "reasoning_effort" => ThoughtConfigId::ReasoningEffort,
                    _ => ThoughtConfigId::ThoughtLevel,
                });
                catalog.current_thought_level = normalize_effort_value(current.as_deref());
                let mut levels = Vec::new();
                for e in entries {
                    if let Some(wire) = e.get("value").and_then(|v| v.as_str()) {
                        if let Some(norm) = normalize_effort_value(Some(wire)) {
                            if !levels.contains(&norm) {
                                levels.push(norm);
                            }
                            catalog.thought_wire_values.insert(norm, wire.to_string());
                        }
                    }
                }
                catalog.thought_levels = levels;
            }
        }
    }

    if catalog.models.is_empty() {
        if let Some(fallbacks) = fallback_models.and_then(|v| v.as_array()) {
            catalog.models = fallbacks
                .iter()
                .filter_map(|m| {
                    let id = m.get("modelId")?.as_str()?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    let raw_name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                    let desc = m.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                    Some(RawModelEntry {
                        id: id.to_string(),
                        name: normalize_tier_display_name(raw_name),
                        supports_images: true,
                        description: desc,
                        supported_efforts: Vec::new(),
                        effort_wire_values: HashMap::new(),
                        default_effort: None,
                        supported_speeds: Vec::new(),
                    })
                })
                .collect();
        }
    }

    catalog
}

pub fn assign_unique_display_names(entries: &mut [BackendModelEntry]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for m in entries.iter() {
        *counts.entry(m.name.clone()).or_insert(0) += 1;
    }

    let mut used = HashSet::new();
    for m in entries.iter_mut() {
        let is_devin = m.backend_kind == BackendKind::Devin;
        let provider_tag = m
            .description
            .split(':')
            .next()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or(&m.backend_label);

        let mut display = m.name.clone();
        if counts.get(&m.name).copied().unwrap_or(0) > 1 {
            if is_devin && !used.contains(&display) {
                // Keep Devin primary copy clean
            } else {
                display = format!("{} ({})", m.name, provider_tag);
            }
        }
        if used.contains(&display) {
            let mut n = 2usize;
            while used.contains(&format!("{display} #{n}")) {
                n += 1;
            }
            display = format!("{display} #{n}");
        }
        used.insert(display.clone());
        m.display_name = display;
    }
}

pub fn format_anthropic_models_list(models: &[BackendModelEntry], gateway_aliases: bool) -> Value {
    let data: Vec<Value> = models
        .iter()
        .map(|m| {
            let id = if gateway_aliases {
                &m.gateway_id
            } else {
                &m.qualified_id
            };
            let mut obj = json!({
                "type": "model",
                "id": id,
                "display_name": m.display_name,
                "description": m.description,
                "max_effort_level": "max",
                "created_at": CREATED_AT_ISO,
                "max_input_tokens": m.max_input_tokens,
                "max_tokens": m.max_tokens,
                "capabilities": {
                    "thinking": {
                        "types": {
                            "enabled": { "supported": true },
                            "adaptive": { "supported": true },
                            "disabled": { "supported": true }
                        }
                    }
                }
            });
            if let Some(line) = infer_model_line(&m.native_id) {
                obj["line"] = json!(line);
            }
            obj
        })
        .collect();

    let first_id = data.first().and_then(|v| v.get("id")).cloned().unwrap_or(Value::Null);
    let last_id = data.last().and_then(|v| v.get("id")).cloned().unwrap_or(Value::Null);

    json!({
        "data": data,
        "has_more": false,
        "first_id": first_id,
        "last_id": last_id
    })
}

pub fn format_openai_models_list(models: &[BackendModelEntry]) -> Value {
    let data: Vec<Value> = models
        .iter()
        .map(|m| {
            json!({
                "id": m.qualified_id,
                "object": "model",
                "created": 1767225600u64,
                "owned_by": m.backend_kind.as_str(),
                "display_name": m.display_name,
                "description": m.description,
                "max_input_tokens": m.max_input_tokens,
                "max_tokens": m.max_tokens
            })
        })
        .collect();

    json!({
        "object": "list",
        "data": data
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_alias_round_trip() {
        let samples = [
            "agy-primary.claude-opus-5-5",
            "agy-a3f9ab07.gemini-4-hydrogen",
            "oc-go.kimi-k2.5",
            "oc-free.big-pickle",
            "grok.grok-4.7",
            "codex.gpt-5.4",
            "deepseek-v4-pro-high",
        ];
        for s in samples {
            let aliased = to_gateway_model_id(s, true);
            assert!(is_claude_desktop_compatible_id(&aliased), "failed for {s} -> {aliased}");
            assert!(!aliased.contains("-h-"), "expected readable alias for {s}, got {aliased}");
            assert_eq!(decode_gateway_model_id(&aliased).as_deref(), Some(s));
        }
    }

    #[test]
    fn opencode_go_free_filter() {
        let models = vec![
            RawModelEntry {
                id: "opencode-go/kimi-k2.5".into(),
                name: "Kimi K2.5".into(),
                supports_images: true,
                description: None,
                supported_efforts: vec![],
                effort_wire_values: HashMap::new(),
                default_effort: None,
                supported_speeds: vec![],
            },
            RawModelEntry {
                id: "opencode/big-pickle".into(),
                name: "Big Pickle".into(),
                supports_images: false,
                description: None,
                supported_efforts: vec![],
                effort_wire_values: HashMap::new(),
                default_effort: None,
                supported_speeds: vec![],
            },
            RawModelEntry {
                id: "openai/gpt-5".into(),
                name: "GPT 5".into(),
                supports_images: true,
                description: None,
                supported_efforts: vec![],
                effort_wire_values: HashMap::new(),
                default_effort: None,
                supported_speeds: vec![],
            },
        ];
        let filtered = filter_opencode_models(&models, OpenCodeFilterMode::GoFree, &[]);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].id, "opencode-go/kimi-k2.5");
        assert_eq!(filtered[1].id, "opencode/big-pickle");
    }

    #[test]
    fn effort_fitting_picks_nearest_supported() {
        let supported = [ThoughtLevel::Medium, ThoughtLevel::High, ThoughtLevel::Max];
        assert_eq!(fit_supported_effort(Some(ThoughtLevel::Xhigh), &supported), Some(ThoughtLevel::Max));
        assert_eq!(fit_supported_effort(Some(ThoughtLevel::Low), &supported), Some(ThoughtLevel::Medium));
    }
}


