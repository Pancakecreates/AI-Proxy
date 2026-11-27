import { invoke } from "@tauri-apps/api/core";
import type { AccountQuotaReport } from "./types";

const CACHE_KEY = "aiproxy.quotas.v1";

interface QuotaCacheEntry {
  at: number;
  reports: AccountQuotaReport[];
}

export function readQuotaCache(): AccountQuotaReport[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QuotaCacheEntry;
    return Array.isArray(parsed.reports) ? parsed.reports : [];
  } catch {
    return [];
  }
}

export function writeQuotaCache(reports: AccountQuotaReport[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), reports }));
  } catch {
    // localStorage может быть недоступен — кеш просто не сохранится
  }
}

export async function refreshQuotas(): Promise<AccountQuotaReport[]> {
  const reports = await invoke<AccountQuotaReport[]>("get_accounts_and_quotas");
  writeQuotaCache(reports);
  return reports;
}
