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
  devin: { src: "/brands/devin.svg", ink: true },
  opencode: { src: "/brands/opencode-icon.svg", ink: true },
  copilot: { src: "/brands/github-copilot.svg", ink: true },
  cursor: { src: "/brands/cursor-icon.svg", ink: true },
  cline: { src: "/brands/cline-icon.svg", ink: true },
  kimi: { src: "/brands/kimi-icon.svg", ink: true },
  flex: { src: "/brands/flex.svg" },
};

const FALLBACK_TINTS: Record<string, { bg: string; fg: string }> = {
  hermes: { bg: "#451a03", fg: "#fcd34d" },
  custom: { bg: "#27272a", fg: "#a1a1aa" },
};

const SparkGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 2.5c.7 4.9 4.6 8.8 9.5 9.5-4.9.7-8.8 4.6-9.5 9.5-.7-4.9-4.6-8.8-9.5-9.5 4.9-.7 8.8-4.6 9.5-9.5Z"
      fill="currentColor"
    />
  </svg>
);

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

  const tint = FALLBACK_TINTS[key] ?? { bg: "#27272a", fg: "#a1a1aa" };

  return (
    <span
      style={{ width: size, height: size, backgroundColor: tint.bg, color: tint.fg }}
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] ${className}`}
      role="img"
      aria-label={brand}
      title={brand}
    >
      <SparkGlyph size={size} />
    </span>
  );
};
