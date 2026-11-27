import React from "react";

interface BrandIconProps {
  brand: string;
  size?: number;
  className?: string;
}

const BRAND_FILES: Record<string, { src: string; ink?: boolean }> = {
  claude: { src: "/brands/claude.svg" },
  anthropic: { src: "/brands/anthropic.svg", ink: true },
  openai: { src: "/brands/openai.svg", ink: true },
  codex: { src: "/brands/openai.svg", ink: true },
  gemini: { src: "/brands/gemini.svg" },
  antigravity: { src: "/brands/gemini.svg" },
  deepseek: { src: "/brands/deepseek.svg" },
  mistral: { src: "/brands/mistral.svg" },
  grok: { src: "/brands/grok.svg", ink: true },
  meta: { src: "/brands/meta.svg" },
  qwen: { src: "/brands/qwen-icon.svg" },
  cohere: { src: "/brands/cohere.svg" },
  nvidia: { src: "/brands/nvidia.svg" },
  perplexity: { src: "/brands/perplexity.svg" },
  "hugging-face": { src: "/brands/hugging-face.svg" },
};

export const BrandIcon: React.FC<BrandIconProps> = ({ brand, size = 18, className = "" }) => {
  const key = brand.toLowerCase();
  const asset = BRAND_FILES[key];

  if (asset) {
    return (
      <img
        src={asset.src}
        alt={brand}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={`shrink-0 object-contain ${asset.ink ? "brand-ink-invert" : ""} ${className}`}
        draggable={false}
      />
    );
  }

  // Fallback geometric marks for CLI-native providers without a separate logo file
  const palette: Record<string, { bg: string; fg: string; text: string }> = {
    devin: { bg: "#14532d", fg: "#86efac", text: "DV" },
    opencode: { bg: "#18181b", fg: "#fafafa", text: "OC" },
    copilot: { bg: "#1f2937", fg: "#93c5fd", text: "CP" },
    cursor: { bg: "#1c1917", fg: "#e7e5e4", text: "CR" },
    cline: { bg: "#0f172a", fg: "#38bdf8", text: "CL" },
    kimi: { bg: "#064e3b", fg: "#6ee7b7", text: "KM" },
    hermes: { bg: "#451a03", fg: "#fcd34d", text: "HM" },
    custom: { bg: "#27272a", fg: "#f4f4f5", text: "AC" },
  };
  const badge = palette[key] ?? { bg: "#27272a", fg: "#f4f4f5", text: key.slice(0, 2).toUpperCase() };

  return (
    <span
      style={{
        width: size,
        height: size,
        backgroundColor: badge.bg,
        color: badge.fg,
        fontSize: Math.max(8, Math.round(size * 0.44)),
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] font-mono font-semibold leading-none ${className}`}
      aria-hidden="true"
    >
      {badge.text}
    </span>
  );
};
