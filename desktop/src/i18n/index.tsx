import React, { createContext, useContext, useMemo } from "react";
import { en } from "./en";
import { setFormatLanguage } from "../format";

export type Language = "ru" | "en";

export function resolveLanguage(setting: string | undefined): Language {
  if (setting === "ru" || setting === "en") return setting;
  const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return nav.toLowerCase().startsWith("ru") ? "ru" : "en";
}

type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`,
  );
}

export function translate(lang: Language, source: string, vars?: Vars): string {
  let template = source;
  if (lang === "en") {
    template = en[source] ?? source;
  }
  return interpolate(template, vars);
}

let currentLang: Language = resolveLanguage(undefined);

// Plain hook-free translator for use anywhere (module constants, helpers).
// The provider remounts the tree on language change, so staleness is bounded.
export function t(source: string, vars?: Vars): string {
  return translate(currentLang, source, vars);
}

interface I18nContextValue {
  lang: Language;
  t: (source: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "ru",
  t: (source) => source,
});

export const I18nProvider: React.FC<{ languageSetting: string | undefined; children: React.ReactNode }> = ({
  languageSetting,
  children,
}) => {
  const value = useMemo<I18nContextValue>(() => {
    const lang = resolveLanguage(languageSetting);
    currentLang = lang;
    setFormatLanguage(lang);
    return {
      lang,
      t: (source, vars) => translate(lang, source, vars),
    };
  }, [languageSetting]);
  return (
    <I18nContext.Provider value={value}>
      <React.Fragment key={value.lang}>{children}</React.Fragment>
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

const RU_FEW = [2, 3, 4];

export function plural(lang: Language, n: number, forms: [string, string, string]): string {
  if (lang === "en") {
    return n === 1 ? forms[0] : forms[2];
  }
  const abs = Math.abs(n) % 100;
  const digit = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (digit > 1 && digit < 5 && RU_FEW.includes(digit)) return forms[1];
  if (digit === 1) return forms[0];
  return forms[2];
}

export function langTag(): string {
  return currentLang === "ru" ? "ru-RU" : "en-US";
}

export function pluralize(n: number, forms: [string, string, string]): string {
  return plural(currentLang, n, forms);
}
