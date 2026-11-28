import type { Language } from "./i18n";

let currentLang: Language = "ru";

export function setFormatLanguage(lang: Language) {
  currentLang = lang;
}

const localeTag = () => (currentLang === "ru" ? "ru-RU" : "en-US");

export const ruNumber = (value: number) => value.toLocaleString(localeTag());

const decimal = (v: number) =>
  currentLang === "ru" ? v.toFixed(1).replace(".", ",") : v.toFixed(1);

export function formatTokens(value: number): string {
  const scaled = (v: number) => (v < 100 ? decimal(v) : ruNumber(Math.round(v)));
  if (currentLang === "ru") {
    if (value >= 1_000_000_000) return `${scaled(value / 1_000_000_000)} млрд`;
    if (value >= 1_000_000) return `${scaled(value / 1_000_000)} млн`;
    if (value >= 10_000) return `${ruNumber(Math.round(value / 1_000))} тыс.`;
    return ruNumber(value);
  }
  if (value >= 1_000_000_000) return `${scaled(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${scaled(value / 1_000_000)}M`;
  if (value >= 10_000) return `${ruNumber(Math.round(value / 1_000))}K`;
  return ruNumber(value);
}

export function formatDuration(ms: number): string {
  if (currentLang === "ru") {
    if (ms >= 1000) return `${decimal(ms / 1000)} с`;
    return `${Math.round(ms)} мс`;
  }
  if (ms >= 1000) return `${decimal(ms / 1000)}s`;
  return `${Math.round(ms)}ms`;
}
