// A key theme: Claude keys use the Claude palette; the Codex key gets its own
// so the two are easy to tell apart at a glance.
export type Theme = {
  bg: string;
  fg: string;
  // Label text and corner glyph.
  accent: string;
  // Big number when over threshold, and the error background.
  warn: string;
  font: string;
  glyph: (x: number, y: number, size: number, color: string) => string;
};

const SANS = "Inter,'Segoe UI',Arial,sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,monospace";

function starburst(x: number, y: number, size: number, color: string): string {
  return `<path transform="translate(${x} ${y}) scale(${size / 20})" fill="${color}"
    d="M10 0 L11.5 8.5 L20 10 L11.5 11.5 L10 20 L8.5 11.5 L0 10 L8.5 8.5 Z"/>`;
}

// Terminal prompt ">_".
function prompt(x: number, y: number, size: number, color: string): string {
  return `<g transform="translate(${x} ${y}) scale(${size / 20})" fill="none" stroke="${color}"
    stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 4 L9 10 L2 16"/><path d="M11 17 H19"/></g>`;
}

// CPU chip with pins.
function chip(x: number, y: number, size: number, color: string): string {
  return `<g transform="translate(${x} ${y}) scale(${size / 20})" fill="none" stroke="${color}"
    stroke-width="2" stroke-linecap="round">
    <rect x="4.5" y="4.5" width="11" height="11" rx="1.5"/>
    <path d="M8 1.5 V4.5 M12 1.5 V4.5 M8 15.5 V18.5 M12 15.5 V18.5 M1.5 8 H4.5 M1.5 12 H4.5 M15.5 8 H18.5 M15.5 12 H18.5"/></g>`;
}

export const CLAUDE_THEME: Theme = {
  bg: "#141413",
  fg: "#faf9f5",
  accent: "#d97757",
  warn: "#d97757",
  font: SANS,
  glyph: starburst,
};

export const CODEX_THEME: Theme = {
  bg: "#0a0a0a",
  fg: "#ffffff",
  accent: "#8ea2ff",
  warn: "#ff6b6b",
  font: MONO,
  glyph: prompt,
};

export const SYSTEM_THEME: Theme = {
  bg: "#0b1210",
  fg: "#ffffff",
  accent: "#4ade80",
  warn: "#ff6b6b",
  font: SANS,
  glyph: chip,
};

// Traffic-light colours for the CPU keys: cool / warm / hot.
export type Level = "ok" | "mid" | "hot";
export const LEVEL_COLORS: Record<Level, string> = {
  ok: "#4ade80",
  mid: "#facc15",
  hot: "#ff6b6b",
};

/** "hot" at or above `hot`, "mid" at or above `mid`, else "ok". */
export function levelFor(value: number, mid: number, hot: number): Level {
  if (value >= hot) return "hot";
  if (value >= mid) return "mid";
  return "ok";
}

// Faint area chart behind the number; values are 0..1, oldest first.
function sparkSvg(values: number[] | undefined, color: string): string {
  if (!values || values.length < 2) return "";
  const top = 34;
  const bottom = 114;
  const step = 144 / (values.length - 1);
  const pts = values.map((v, i) => {
    const c = Math.min(1, Math.max(0, v));
    return `${(i * step).toFixed(1)},${(bottom - c * (bottom - top)).toFixed(1)}`;
  });
  return `<polygon points="0,${bottom} ${pts.join(" ")} 144,${bottom}" fill="${color}" opacity="0.14"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" opacity="0.45"/>`;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Small account tag in the top-left corner (mirrors the glyph top-right).
function badgeSvg(badge: string | undefined, fill: string, font: string): string {
  if (!badge) return "";
  return `<text x="12" y="25" font-family="${font}"
    font-weight="700" font-size="15" letter-spacing="1" fill="${fill}" opacity="0.8">${escapeXml(badge)}</text>`;
}

// Amber "20M OLD" tag for figures that may be out of date. Top-left on keys
// without an account badge; otherwise right of the badge, before the glyph.
const STALE_COLOR = "#ffb347";

function staleSvg(stale: string | undefined, font: string, hasBadge: boolean): string {
  if (!stale) return "";
  const pos = hasBadge
    ? `x="112" y="24" text-anchor="end" font-size="12"`
    : `x="12" y="25" font-size="13"`;
  return `<text ${pos} font-family="${font}"
    font-weight="700" letter-spacing="1" fill="${STALE_COLOR}">${escapeXml(stale)}</text>`;
}

function fontSize(text: string): number {
  if (text.length <= 3) return 36;
  if (text.length <= 4) return 32;
  if (text.length <= 6) return 26;
  return 22;
}

export function renderKey(opts: {
  big: string;
  label: string;
  subtitle?: string;
  accent?: boolean;
  badge?: string;
  theme?: Theme;
  spark?: number[];
  // Traffic-light level; colours the number and sparkline (overrides accent).
  level?: Level;
  // Out-of-date tag (e.g. "2D OLD"): drawn top-left and dims the number.
  stale?: string;
}): string {
  const t = opts.theme ?? CLAUDE_THEME;
  const levelColor = opts.level ? LEVEL_COLORS[opts.level] : undefined;
  const numColor = levelColor ?? (opts.accent ? t.warn : t.fg);
  const size = fontSize(opts.big);
  const subSize = opts.subtitle && opts.subtitle.length > 11 ? 15 : 17;
  const sub = opts.subtitle
    ? `<text x="72" y="102" text-anchor="middle" font-family="${t.font}"
         font-weight="500" font-size="${subSize}" fill="${t.fg}" opacity="0.9">${escapeXml(opts.subtitle)}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="${t.bg}"/>
    ${sparkSvg(opts.spark, levelColor ?? (opts.accent ? t.warn : t.accent))}
    ${t.glyph(118, 10, 18, t.accent)}
    ${badgeSvg(opts.badge, t.fg, t.font)}
    ${staleSvg(opts.stale, t.font, !!opts.badge)}
    <text x="72" y="66" text-anchor="middle" font-family="${t.font}"
          font-weight="700" font-size="${size}" fill="${numColor}"${opts.stale ? ` opacity="0.55"` : ""}>${escapeXml(opts.big)}</text>
    ${sub}
    <text x="72" y="130" text-anchor="middle" font-family="${t.font}"
          font-weight="600" font-size="13" letter-spacing="2" fill="${t.accent}">${escapeXml(opts.label)}</text>
  </svg>`;
  return svgToDataUrl(svg);
}

// `hint` is a short reason (e.g. "SIGN-IN") drawn under the label.
export function renderError(
  label: string,
  badge?: string,
  theme: Theme = CLAUDE_THEME,
  hint?: string
): string {
  const t = theme;
  const y = hint ? { mark: 82, label: 110 } : { mark: 92, label: 124 };
  const hintSvg = hint
    ? `<text x="72" y="130" text-anchor="middle" font-family="${t.font}"
          font-weight="700" font-size="11" letter-spacing="1" fill="${t.bg}" opacity="0.75">${escapeXml(hint)}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="${t.warn}"/>
    ${badgeSvg(badge, t.bg, t.font)}
    <text x="72" y="${y.mark}" text-anchor="middle" font-family="${t.font}"
          font-weight="800" font-size="80" fill="${t.bg}">!</text>
    <text x="72" y="${y.label}" text-anchor="middle" font-family="${t.font}"
          font-weight="600" font-size="11" letter-spacing="2" fill="${t.bg}">${escapeXml(label)}</text>
    ${hintSvg}
  </svg>`;
  return svgToDataUrl(svg);
}

export function renderLoading(label: string, badge?: string, theme: Theme = CLAUDE_THEME): string {
  const t = theme;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="${t.bg}"/>
    ${badgeSvg(badge, t.fg, t.font)}
    ${t.glyph(62, 48, 20, t.accent)}
    <text x="72" y="100" text-anchor="middle" font-family="${t.font}"
          font-weight="500" font-size="13" letter-spacing="1" fill="${t.fg}" opacity="0.55">loading</text>
    <text x="72" y="124" text-anchor="middle" font-family="${t.font}"
          font-weight="600" font-size="11" letter-spacing="2" fill="${t.accent}">${escapeXml(label)}</text>
  </svg>`;
  return svgToDataUrl(svg);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatPercent(n: number): string {
  return `${Math.round(n)}%`;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "CA$",
  AUD: "A$",
  JPY: "¥",
};

const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND"]);

function symbol(code: string): string {
  return CURRENCY_SYMBOL[code] ?? `${code} `;
}

function major(amount: number, code: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(code) ? amount : amount / 100;
}

export function formatCurrencyShort(amount: number, code: string): string {
  const n = major(amount, code);
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
  return `${symbol(code)}${n.toFixed(decimals)}`;
}

export function formatUsedOfLimit(used: number, limit: number, code: string): string {
  const u = major(used, code);
  const l = major(limit, code);
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
  return `${symbol(code)}${u.toFixed(decimals)}/${symbol(code)}${l.toFixed(decimals)}`;
}

export function formatResetsIn(isoString: string | null | undefined): string | undefined {
  if (!isoString) return undefined;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return undefined;
  const diffMs = t - Date.now();
  if (diffMs <= 0) return "resetting";
  const totalMin = Math.round(diffMs / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours < 24) return mins ? `in ${totalHours}h ${mins}m` : `in ${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `in ${days}d ${hours}h` : `in ${days}d`;
}
