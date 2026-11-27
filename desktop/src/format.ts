export const ruNumber = (value: number) => value.toLocaleString("ru-RU");

export function formatTokens(value: number): string {
  const scaled = (v: number) =>
    v < 100 ? v.toFixed(1).replace(".", ",") : ruNumber(Math.round(v));
  if (value >= 1_000_000_000) return `${scaled(value / 1_000_000_000)} млрд`;
  if (value >= 1_000_000) return `${scaled(value / 1_000_000)} млн`;
  if (value >= 10_000) return `${ruNumber(Math.round(value / 1_000))} тыс.`;
  return ruNumber(value);
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
  return `${Math.round(ms)} мс`;
}
