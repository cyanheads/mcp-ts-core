/**
 * @fileoverview Inlined `<style>` block for the landing page. Defines design
 * tokens, `prefers-color-scheme`-aware color system, hero/connect/card/section
 * component styles, and responsive + reduced-motion overrides. The only
 * interpolation is the accent color, which the caller supplies from the
 * server manifest theme.
 *
 * @module src/mcp-server/transports/http/landing-page/assets/styles
 */

import { isSafeCssColor } from '@/core/serverManifest.js';
import { type SafeHtml, unsafeRaw } from '@/utils/formatting/html.js';

/** Fallback when the caller-supplied accent fails the CSS-safety check. */
const DEFAULT_ACCENT = '#6366f1';

/**
 * Single inlined `<style>` block. No external CSS, no fonts.
 *
 * `buildServerManifest` is the primary defense against CSS injection through
 * `accent` — it throws on malformed values at startup. This function adds a
 * second line of defense for callers that construct a manifest directly
 * (tests, programmatic use): anything that fails the CSS-safety check is
 * silently replaced with the default indigo.
 */
export function renderTokens(accent: string): SafeHtml {
  const safeAccent = isSafeCssColor(accent) ? accent : DEFAULT_ACCENT;
  const css = `
:root {
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --space-12: 48px; --space-16: 64px; --space-20: 80px;

  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 1rem;
  --text-lg: 1.125rem; --text-xl: 1.25rem; --text-2xl: 1.5rem;
  --text-3xl: 1.875rem;
  --text-display: clamp(2rem, 4.5vw + 0.5rem, 3.5rem);

  --radius-xs: 4px; --radius-sm: 6px; --radius-md: 10px;
  --radius-lg: 14px; --radius-pill: 999px;

  --font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --duration-fast: 120ms; --duration-base: 200ms; --duration-slow: 320ms;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);

  --accent: ${safeAccent};
  --accent-hover: color-mix(in oklab, ${safeAccent}, black 10%);
  --accent-edge: color-mix(in oklab, ${safeAccent}, transparent 65%);
  --accent-soft: color-mix(in oklab, ${safeAccent}, transparent 82%);
  --accent-softer: color-mix(in oklab, ${safeAccent}, transparent 92%);
  /* Secondary accent — hue-shifted companion for richer gradients. */
  /* Fallback (lighter tonal variant) first; modern relative-color value overrides on supported engines. */
  --accent-2: color-mix(in oklab, var(--accent), white 30%);
  --accent-2: oklch(from var(--accent) l c calc(h + 30));
  --accent-glow: color-mix(in oklab, var(--accent), transparent 72%);

  /* Warn palette — amber. Pre-release chip today; reusable for future warning surfaces. */
  --warn: #f59e0b;
  --warn-text: #b45309;
  --warn-bg: color-mix(in oklab, var(--warn), transparent 88%);
  --warn-edge: color-mix(in oklab, var(--warn), transparent 65%);

  --bg: #fbfbfd;
  --bg-subtle: #f4f4f7;
  --bg-elevated: #ffffff;
  --bg-code: #f6f7fa;
  --fg: #09090b;
  --fg-muted: #52525b;
  --fg-subtle: #71717a;
  --border: #e4e4e7;
  --border-subtle: #ececf0;
  --border-strong: #d4d4d8;
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.04);
  --shadow-md: 0 4px 20px -8px rgb(0 0 0 / 0.08), 0 1px 2px rgb(0 0 0 / 0.04);
  --grid-dot: rgb(0 0 0 / 0.045);
  --glow-strength: 0.10;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0b12;
    --bg-subtle: #11131a;
    --bg-elevated: #10121a;
    --bg-code: #0c0d14;
    --fg: #ededef;
    --fg-muted: #a1a1a8;
    --fg-subtle: #8a8a93;
    --border: #22232b;
    --border-subtle: #191a21;
    --border-strong: #2d2e37;
    --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.35);
    --shadow-md: 0 4px 24px -8px rgb(0 0 0 / 0.55), 0 1px 2px rgb(0 0 0 / 0.3);
    --grid-dot: rgb(255 255 255 / 0.032);
    --glow-strength: 0.17;
    --accent-glow: color-mix(in oklab, var(--accent), transparent 60%);
    --warn-text: #fbbf24;
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light dark; }

body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  position: relative;
  overflow-x: hidden;
}

/* Top accent hairline — spans viewport, dual-accent gradient. */
body::before {
  content: "";
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg,
    transparent 0%,
    color-mix(in oklab, var(--accent), transparent 60%) 12%,
    var(--accent) 35%,
    var(--accent-2) 65%,
    color-mix(in oklab, var(--accent-2), transparent 60%) 88%,
    transparent 100%);
  z-index: 100;
  pointer-events: none;
}

/* Ambient background — dual radial glow (accent top-left, accent-2 top-right) + fine dot grid. */
body::after {
  content: "";
  position: fixed;
  inset: 0;
  background-image:
    radial-gradient(ellipse 70% 55% at 12% -5%, color-mix(in oklab, var(--accent), transparent calc((1 - var(--glow-strength)) * 100%)), transparent 60%),
    radial-gradient(ellipse 55% 45% at 92% 10%, color-mix(in oklab, var(--accent-2), transparent calc((1 - var(--glow-strength)) * 115%)), transparent 55%),
    radial-gradient(circle at center, var(--grid-dot) 1px, transparent 1.5px);
  background-size: 100% 100%, 100% 100%, 24px 24px;
  pointer-events: none;
  z-index: -1;
}

::selection { background: var(--accent-soft); color: var(--fg); }

main {
  max-width: 1120px;
  margin: 0 auto;
  padding: var(--space-10) var(--space-6) var(--space-20);
  position: relative;
}

a {
  color: var(--accent);
  text-decoration: none;
  transition: color var(--duration-fast) var(--ease-out);
}
a:hover { color: var(--accent-hover); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

code, pre {
  font-family: var(--font-mono);
  font-size: 0.875em;
  font-feature-settings: "liga" 0, "calt" 0;
}
code {
  background: var(--bg-subtle);
  padding: 0.1em 0.35em;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  font-size: 0.85em;
}
pre {
  background: var(--bg-code);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: var(--space-4);
  margin: 0;
  overflow-x: auto;
  line-height: 1.55;
  white-space: pre;
  color: var(--fg);
}
pre code { background: transparent; padding: 0; border: 0; font-size: inherit; }

/* -------------------- Hero -------------------- */

.hero {
  padding: var(--space-12) 0 var(--space-10);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

/* Page-load choreography — staggered rise on the hero stack. The
   "backwards" animation-fill-mode applies the from-state during the
   delay so the page never flashes the final layout before animating.
   Reduced-motion override at the bottom of this stylesheet collapses
   the animation. */
@keyframes hero-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}
.hero > * { animation: hero-rise 600ms var(--ease-out) backwards; }
.hero > .hero-eyebrow   { animation-delay:  60ms; }
.hero > .hero-title-row { animation-delay: 140ms; }
.hero > .hero-tagline   { animation-delay: 220ms; }
.hero > .status-strip   { animation-delay: 300ms; }
.hero > .connect        { animation-delay: 380ms; }
.hero > .hero-badges    { animation-delay: 460ms; }

.hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
}
.hero-eyebrow::before {
  content: "";
  width: 5px; height: 5px;
  background: var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 10px var(--accent);
}

.hero-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.hero-logo {
  width: 44px; height: 44px;
  border-radius: var(--radius-md);
  object-fit: contain;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  flex-shrink: 0;
}
.hero-heading {
  margin: 0;
  font-size: var(--text-display);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.02;
  color: var(--fg);
  word-break: break-word;
  flex: 1 1 auto;
  min-width: 0;
}
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .hero-heading {
    background: linear-gradient(180deg,
      color-mix(in oklab, var(--fg), var(--accent) 10%) 0%,
      var(--fg) 45%,
      color-mix(in oklab, var(--fg), transparent 22%) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
}
.hero-tagline {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-lg);
  line-height: 1.5;
  max-width: 62ch;
}

/* Version + pre-release chips */
.badge-version {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  background: var(--accent-softer);
  border: 1px solid var(--accent-edge);
  text-decoration: none;
  transition: background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.badge-version:hover {
  background: var(--accent-soft);
  color: var(--accent);
  text-decoration: none;
  transform: translateY(-1px);
}
.badge-pre {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--warn-text);
  background: var(--warn-bg);
  border: 1px solid var(--warn-edge);
}

/* Status strip — single line under the tagline. */
.status-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  letter-spacing: 0.01em;
}
.status-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  position: relative;
}
.status-item + .status-item::before {
  content: "·";
  color: var(--fg-subtle);
  margin-right: var(--space-2);
  opacity: 0.7;
}
.status-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.status-dot-public {
  background: #22c55e;
  box-shadow: 0 0 0 3px color-mix(in oklab, #22c55e, transparent 80%);
  animation: status-pulse 2.4s ease-in-out infinite;
}
.status-dot-gated {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent), transparent 75%);
}
@keyframes status-pulse {
  0%, 100% { box-shadow: 0 0 0 3px color-mix(in oklab, #22c55e, transparent 80%); }
  50% { box-shadow: 0 0 0 6px color-mix(in oklab, #22c55e, transparent 92%); }
}
.status-value {
  color: var(--fg);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.status-value-accent {
  color: var(--accent);
}
.status-signin {
  color: var(--fg-muted);
  text-decoration: none;
  border-bottom: 1px dotted var(--fg-subtle);
}
.status-signin:hover { color: var(--accent); border-color: var(--accent); }
.status-link {
  color: inherit;
  text-decoration: none;
  transition: color var(--duration-fast) var(--ease-out);
}
.status-link .status-value { transition: color var(--duration-fast) var(--ease-out); }
.status-link:hover,
.status-link:hover .status-value { color: var(--accent); }
.status-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: 2px;
}

/* -------------------- Connect card -------------------- */

/* Registered custom property enables animation of a gradient angle.
   Without @property the custom-property value would change discretely rather
   than tweening, so the beam would jump instead of sweep. Widely supported
   since 2023 — engines without it fall through to the static border. */
@property --beam-angle {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}

.connect {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  overflow: hidden;
  box-shadow: var(--shadow-md);
  position: relative;
  isolation: isolate;
}

/* Animated conic-gradient beam sweeping the inside of the card edge. Uses the
   "mask-composite: exclude" trick to render only the outer ring. Sits just
   inside the static border so it reads as accent light traveling along the
   rim; the static border remains as a fallback for engines without
   mask-composite or @property. */
.connect::before {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1.5px;
  border-radius: inherit;
  background: conic-gradient(
    from var(--beam-angle),
    transparent 0deg 40deg,
    var(--accent) 90deg,
    var(--accent-2) 160deg,
    transparent 220deg 360deg
  );
  mask:
    linear-gradient(#000, #000) content-box,
    linear-gradient(#000, #000);
  mask-composite: exclude;
  -webkit-mask-composite: xor;
  animation: connect-beam 7s linear infinite;
  pointer-events: none;
  z-index: 1;
  opacity: 0.9;
}

@keyframes connect-beam {
  to {
    --beam-angle: 360deg;
  }
}

/* Chrome header — three dots + endpoint path */
.connect-chrome {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
}
.connect-chrome-dots {
  display: inline-flex;
  gap: 6px;
  flex-shrink: 0;
}
.connect-chrome-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: color-mix(in oklab, var(--fg-subtle), transparent 60%);
  display: inline-block;
  transition: background var(--duration-base) var(--ease-out);
}
/* Hovering the dot cluster colors them like real OS window controls.
   Pure delight — fits the terminal-chrome metaphor without adding
   anything to the meaningful surface. */
.connect-chrome-dots:hover .connect-chrome-dot:nth-child(1) { background: #ff5f57; }
.connect-chrome-dots:hover .connect-chrome-dot:nth-child(2) { background: #febc2e; }
.connect-chrome-dots:hover .connect-chrome-dot:nth-child(3) { background: #28c840; }
.connect-chrome-endpoint {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* Radio-hack tabs */
.connect-tab-input { position: absolute; opacity: 0; pointer-events: none; }
.connect-tabs {
  display: flex;
  gap: 0;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  overflow-x: auto;
  scrollbar-width: none;
}
.connect-tabs::-webkit-scrollbar { display: none; }
.connect-tab-label {
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--fg-muted);
  cursor: pointer;
  border-bottom: 3px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}
.connect-tab-label:hover { color: var(--fg); }
.connect-tab-input:checked + .connect-tab-label {
  color: var(--fg);
  font-weight: 600;
  border-bottom-color: var(--accent);
  background: linear-gradient(to top, var(--accent-softer), transparent 70%);
}
.connect-tab-input:focus-visible + .connect-tab-label {
  outline: 2px solid var(--accent);
  outline-offset: -6px;
  border-radius: var(--radius-sm);
}

.connect-panels { position: relative; padding: var(--space-5) var(--space-4); }
.connect-panel { display: none; }
.connect:has(#connect-tab-stdio:checked) .panel-stdio,
.connect:has(#connect-tab-http:checked) .panel-http,
.connect:has(#connect-tab-claude:checked) .panel-claude,
.connect:has(#connect-tab-curl:checked) .panel-curl { display: block; }
/* Fallback when :has() unsupported — show first visible panel */
@supports not selector(:has(*)) {
  .connect-panel:first-of-type { display: block; }
}
.connect-panel pre {
  padding: var(--space-4);
  padding-right: var(--space-12);
  background: var(--bg-code);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  line-height: 1.6;
}
.connect-copy {
  position: absolute;
  top: calc(var(--space-5) + 8px);
  right: calc(var(--space-4) + 8px);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg-muted);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  letter-spacing: 0.02em;
}
.connect-copy:hover {
  color: var(--accent);
  border-color: var(--accent-edge);
  background: var(--accent-softer);
}
.connect-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.connect-copy[data-copied="true"] {
  color: #16a34a;
  border-color: color-mix(in oklab, #16a34a, transparent 60%);
  background: color-mix(in oklab, #16a34a, transparent 92%);
}

/* Framework attribution pill */
.hero-badges {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.badge-shield {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--fg-muted);
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  text-decoration: none;
  transition: all var(--duration-fast) var(--ease-out);
}
.badge-shield:hover {
  color: var(--accent);
  border-color: var(--accent-edge);
  background: var(--accent-softer);
  text-decoration: none;
  transform: translateY(-1px);
}
.badge-shield-label { color: var(--fg-subtle); transition: color var(--duration-fast); }
.badge-shield-value { color: var(--fg-muted); transition: color var(--duration-fast); }
.badge-shield:hover .badge-shield-label,
.badge-shield:hover .badge-shield-value { color: var(--accent); }

/* -------------------- Sections -------------------- */

section { padding: var(--space-12) 0 0; }

.section-heading {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin: 0 0 var(--space-6);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}
.section-heading h2 {
  margin: 0;
  font-size: var(--text-2xl);
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--fg);
  text-transform: lowercase;
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}
.section-heading h2::before {
  content: "";
  display: inline-block;
  width: 3px;
  height: 0.9em;
  background: linear-gradient(180deg, var(--accent), var(--accent-2));
  border-radius: 2px;
  flex-shrink: 0;
}
.section-count {
  font-family: var(--font-mono);
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1;
}

.group-heading {
  margin: var(--space-6) 0 var(--space-3);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: lowercase;
  letter-spacing: 0.06em;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  position: relative;
  padding-left: var(--space-3);
}
.group-heading::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 0.85em;
  background: var(--accent);
  border-radius: 1px;
}
.group-heading:first-child { margin-top: 0; }
.group-heading[data-group="read"]::before { background: #16a34a; }
.group-heading[data-group="destructive"]::before { background: #dc2626; }
.group-count {
  color: var(--fg-subtle);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

/* -------------------- Tool filter bar -------------------- */

.tool-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
  margin-bottom: var(--space-5);
}
.tool-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tool-chip {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  letter-spacing: 0.01em;
  transition:
    color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.tool-chip:hover { color: var(--fg); border-color: var(--border-strong); }
.tool-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tool-chip[aria-pressed="true"] {
  color: var(--accent);
  background: var(--accent-softer);
  border-color: var(--accent-edge);
}
.tool-chip--read[aria-pressed="true"] {
  color: #16a34a;
  background: color-mix(in oklab, #16a34a, transparent 92%);
  border-color: color-mix(in oklab, #16a34a, transparent 72%);
}
.tool-chip--destructive[aria-pressed="true"] {
  color: #dc2626;
  background: color-mix(in oklab, #dc2626, transparent 92%);
  border-color: color-mix(in oklab, #dc2626, transparent 72%);
}
.tool-chip--unspecified[aria-pressed="true"] {
  color: var(--fg-muted);
  background: var(--bg-subtle);
  border-color: var(--border);
  font-style: italic;
}
.tool-chip--disabled[aria-pressed="true"] {
  color: var(--fg-subtle);
  background: var(--bg-subtle);
  border-color: var(--border);
  font-style: italic;
}
@media (prefers-color-scheme: dark) {
  .tool-chip--read[aria-pressed="true"] { color: #4ade80; }
  .tool-chip--destructive[aria-pressed="true"] { color: #f87171; }
}

.tool-search {
  flex: 1 1 200px;
  min-width: 0;
  max-width: 360px;
  margin-left: auto;
  display: flex;
  align-items: center;
  position: relative;
}
.tool-search input {
  width: 100%;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  padding: 6px 12px 6px 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--fg);
  transition:
    border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.tool-search input::placeholder { color: var(--fg-subtle); }
.tool-search input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-softer);
}
.tool-search::before {
  /* Search glyph — no icon font, just a styled box. */
  content: "";
  position: absolute;
  left: 10px;
  top: 50%;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--fg-subtle);
  border-radius: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}
.tool-search::after {
  content: "";
  position: absolute;
  left: 19px;
  top: calc(50% + 4px);
  width: 5px;
  height: 1.5px;
  background: var(--fg-subtle);
  transform: rotate(45deg);
  pointer-events: none;
  border-radius: 1px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.tools-empty {
  margin: var(--space-6) 0;
  padding: var(--space-8) var(--space-6);
  text-align: center;
  color: var(--fg-muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}

/* -------------------- Cards -------------------- */

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--space-3);
  align-items: stretch;
}
.card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
  background: var(--bg-elevated);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  transition: border-color var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
  position: relative;
  height: 100%;
}

/* Mutability spine — 3px tonal strip down the left edge of each tool
   card. Bird's-eye scannability: a row of cards reads as a row of
   colored bars before the eye lands on any title. */
.tool-card { padding-left: calc(var(--space-5) + 3px); }
.tool-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: var(--space-2);
  bottom: var(--space-2);
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--card-spine, var(--border-strong));
  transition: background var(--duration-fast) var(--ease-out);
}
.tool-card[data-mutability="read"] { --card-spine: #16a34a; }
.tool-card[data-mutability="unspecified"] { --card-spine: var(--border); }
.tool-card[data-mutability="write"] { --card-spine: var(--border-strong); }
.tool-card[data-mutability="destructive"] { --card-spine: #dc2626; }
.tool-card[data-mutability="disabled"] { --card-spine: var(--border); }
@media (prefers-color-scheme: dark) {
  .tool-card[data-mutability="read"] { --card-spine: #4ade80; }
  .tool-card[data-mutability="destructive"] { --card-spine: #f87171; }
}

/* Disabled tool card — muted overall to read as "present but not callable".
   Hover lift is disabled too; no invocation snippet means there's no
   interactive payoff to suggest. */
.tool-card--disabled {
  background: var(--bg-subtle);
  border-style: dashed;
}
.tool-card--disabled .card-title a { color: var(--fg-muted); }
.tool-card--disabled .card-desc { color: var(--fg-subtle); }
.tool-card--disabled:hover {
  border-color: var(--border-strong);
  transform: none;
  box-shadow: none;
}
.tool-card--disabled::before { opacity: 0.5; }
.card:hover {
  border-color: var(--accent-edge);
  transform: translateY(-1px);
  box-shadow: 0 8px 28px -12px var(--accent-glow), var(--shadow-md);
}
.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.card-title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--fg);
  letter-spacing: -0.015em;
}
.card-title a { color: inherit; }
.card-title a:hover { color: var(--accent); text-decoration: none; }
.card-desc {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.5;
  /* 3-line preview clamp keeps cards uniform; full text stays in DOM
     for screen readers and view-source. Non-WebKit engines fall back
     to the natural height — overflow:hidden truncates to 3 lines via
     max-height as a graceful degradation. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-height: calc(1.5em * 3);
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  align-items: center;
}
.card-meta-label {
  color: var(--fg-subtle);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
}
.card-meta code {
  font-size: 1em;
  color: var(--fg);
  background: transparent;
  border: 0;
  padding: 0;
}

/* Card footer — pinned to the bottom so cards align across a row even
   when descriptions vary in length. Carries the scope chip on the left
   and the invocation/schema action triggers on the right. */
.card-foot {
  margin-top: auto;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
}
.card-scope {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.scope-chip {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-subtle);
  color: var(--fg);
  border: 1px solid var(--border-subtle);
  letter-spacing: 0.02em;
}
.card-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}
.card-detail { margin: 0; }
.card-detail > summary {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  cursor: pointer;
  transition: color var(--duration-fast);
}
.card-detail > summary::before {
  content: "▸";
  display: inline-block;
  font-size: 0.6rem;
  transition: transform var(--duration-fast);
  color: var(--fg-subtle);
}
.card-detail[open] > summary::before {
  transform: rotate(90deg);
  color: var(--accent);
}
.card-detail > summary:hover { color: var(--accent); }
.card-detail[open] > summary { color: var(--accent); }
/* When a detail opens, push its content full-width below the footer. The
   negative side margins recover the card's horizontal padding so the
   panel spans edge-to-edge. */
.card-detail[open] {
  width: 100%;
  margin: var(--space-3) calc(var(--space-5) * -1) calc(var(--space-4) * -1);
  padding: 0 var(--space-5) var(--space-4);
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-subtle);
}
.card-detail[open] > summary { padding-top: var(--space-3); }
/* When any detail is open the actions row needs to wrap so the open
   panel can claim full width. The :has() selector handles this in
   modern engines; older browsers tolerate the actions row stacking
   inline-flex without the layout flip. */
.card-foot:has(.card-detail[open]) {
  flex-direction: column;
  align-items: stretch;
}
.card-foot:has(.card-detail[open]) .card-actions {
  width: 100%;
  margin-left: 0;
}

/* Annotation pills — dot-chip style */
.pill-row { display: inline-flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1.4;
  color: var(--fg-muted);
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  letter-spacing: 0.01em;
}
.pill::before {
  content: "";
  width: 4px; height: 4px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
/* Mutability badges — primary safety signal, sized to pass a squint test. */
.pill-read { color: #16a34a; background: color-mix(in oklab, #16a34a, transparent 88%); border-color: color-mix(in oklab, #16a34a, transparent 65%); }
.pill-write { color: var(--fg-muted); background: var(--bg-subtle); border-color: var(--border); }
/* The unspecified bucket reads as indeterminate, not "write" — italic +
   lighter weight visually separates it from the deliberate-mutation signal
   of pill-write. */
.pill-unspecified {
  color: var(--fg-subtle);
  background: var(--bg-subtle);
  border-color: var(--border);
  font-style: italic;
  font-weight: 400;
}
.pill-destructive { color: #dc2626; background: color-mix(in oklab, #dc2626, transparent 88%); border-color: color-mix(in oklab, #dc2626, transparent 65%); font-weight: 600; }
.pill-openworld { color: #2563eb; background: color-mix(in oklab, #2563eb, transparent 92%); border-color: color-mix(in oklab, #2563eb, transparent 72%); }
.pill-task { color: var(--accent); background: var(--accent-softer); border-color: var(--accent-edge); }
.pill-app { color: #9333ea; background: color-mix(in oklab, #9333ea, transparent 92%); border-color: color-mix(in oklab, #9333ea, transparent 72%); }
.pill-auth { color: var(--fg-subtle); font-size: 0.65rem; }
.pill-auth::before { display: none; }
.pill-disabled {
  color: var(--fg-subtle);
  background: var(--bg-subtle);
  border-color: var(--border);
  font-style: italic;
}
/* "would be <mutability>" pills shown alongside the disabled badge — even more
   muted than the regular mutability pills so the eye lands on disabled first. */
.pill-read-muted,
.pill-write-muted,
.pill-destructive-muted {
  color: var(--fg-subtle);
  background: var(--bg-subtle);
  border-color: var(--border);
  font-size: 0.65rem;
  opacity: 0.85;
}
.pill-read-muted::before,
.pill-write-muted::before,
.pill-destructive-muted::before { display: none; }

/* Disabled callout — replaces the invocation snippet with operator-facing
   context about why the tool is disabled and how to enable it. */
.disabled-callout {
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-subtle);
  margin-top: var(--space-1);
}
.disabled-reason {
  margin: 0 0 var(--space-1) 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  line-height: 1.5;
}
.disabled-reason strong { color: var(--fg); font-weight: 600; }
.disabled-since {
  display: inline-block;
  margin-left: var(--space-1);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  font-family: var(--font-mono);
}
.disabled-hint {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  color: var(--fg);
  overflow-x: auto;
}
.disabled-hint code { background: transparent; border: 0; padding: 0; }

@media (prefers-color-scheme: dark) {
  .pill-read { color: #4ade80; }
  .pill-destructive { color: #f87171; }
  .pill-openworld { color: #60a5fa; }
  .pill-app { color: #c084fc; }
}

.source-link {
  font-size: var(--text-xs);
  color: var(--fg-muted);
  margin-left: auto;
  font-family: var(--font-mono);
  transition: color var(--duration-fast);
}
.source-link:hover { color: var(--accent); text-decoration: none; }

/* Inline snippet (tool invocation) */
.snippet {
  position: relative;
  margin-top: var(--space-2);
}
.snippet pre {
  padding: var(--space-3);
  padding-right: var(--space-12);
  background: var(--bg-code);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  line-height: 1.55;
}
.snippet-copy {
  position: absolute;
  top: 6px;
  right: 6px;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 500;
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg-muted);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-out);
  letter-spacing: 0.02em;
}
.snippet-copy:hover { color: var(--accent); border-color: var(--accent-edge); }
.snippet-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.snippet-copy[data-copied="true"] {
  color: #16a34a;
  border-color: color-mix(in oklab, #16a34a, transparent 60%);
}

/* Collapsible details (schema preview) */
details {
  margin-top: var(--space-1);
  border: 0;
  border-radius: 0;
}
details > summary {
  cursor: pointer;
  padding: 4px 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  list-style: none;
  user-select: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  transition: color var(--duration-fast);
}
details > summary::-webkit-details-marker { display: none; }
details > summary::before {
  content: "+";
  display: inline-block;
  width: 10px;
  text-align: center;
  color: var(--fg-muted);
  font-weight: 600;
  transition: transform var(--duration-fast), color var(--duration-fast);
}
details[open] > summary::before { content: "−"; color: var(--accent); }
details > summary:hover { color: var(--accent); }
details > pre {
  margin-top: var(--space-2);
  font-size: 0.7rem;
  line-height: 1.55;
}

/* Prompt args */
.args-list {
  list-style: none;
  padding: 0;
  margin: var(--space-1) 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--fg-muted);
  font-family: var(--font-mono);
}
.args-list li { line-height: 1.6; }
.args-list code {
  font-size: 1em;
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--fg);
}
.args-required {
  color: var(--accent);
  font-size: 0.625rem;
  font-weight: 600;
  margin-left: 5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* Extensions */
.ext-card { background: var(--bg-subtle); border-color: var(--border-subtle); }
.ext-key { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg); }
.ext-preview {
  margin: var(--space-2) 0 0;
  font-size: 0.7rem;
  line-height: 1.55;
}

/* Empty / degraded state */
.empty-state {
  padding: var(--space-10) var(--space-6);
  text-align: center;
  color: var(--fg-muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}

/* -------------------- Footer -------------------- */

footer {
  margin-top: var(--space-20);
  padding: var(--space-6) 0;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  letter-spacing: 0.01em;
}
footer a {
  color: var(--fg-muted);
  text-decoration: none;
  transition: color var(--duration-fast) var(--ease-out);
}
footer a:hover { color: var(--accent); text-decoration: none; }
.footer-sep { color: var(--fg-subtle); opacity: 0.5; user-select: none; }
.footer-spacer { flex: 1 0 var(--space-4); }
.footer-attrib { color: var(--fg-subtle); }
.footer-attrib a { color: var(--fg-muted); }

/* -------------------- Responsive -------------------- */

@media (max-width: 760px) {
  main { padding: var(--space-6) var(--space-4) var(--space-16); }
  .hero { padding: var(--space-8) 0 var(--space-6); gap: var(--space-5); }
  .hero-heading { font-size: clamp(1.875rem, 7vw + 0.5rem, 2.5rem); letter-spacing: -0.035em; }
  .hero-title-row { gap: var(--space-3); }
  .hero-logo { width: 40px; height: 40px; }
  .hero-tagline { font-size: var(--text-base); }
  .status-strip { gap: var(--space-2); font-size: 0.6875rem; }
  .connect-chrome-endpoint { display: none; }
  .card-grid { grid-template-columns: 1fr; }
  section { padding: var(--space-8) 0 0; }
  .section-heading h2 { font-size: var(--text-xl); }
  .section-count { font-size: var(--text-xl); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;
  return unsafeRaw(`<style>${css}</style>`);
}
