// Mr. Polish brand tokens — mirrored exactly from the website styles.css (:root)
// Palette: Deep Charcoal (dominant) + Metallic Gold (accent) + Navy (secondary)
export const brand = {
  char950: "oklch(0.17 0.006 264)",
  char900: "oklch(0.21 0.007 264)",
  char850: "oklch(0.25 0.008 264)",
  char800: "oklch(0.29 0.009 264)",
  char700: "oklch(0.37 0.009 264)",
  gold700: "oklch(0.66 0.12 84)",
  gold600: "oklch(0.74 0.13 86)",
  gold500: "oklch(0.82 0.13 88)",
  gold400: "oklch(0.88 0.10 90)",
  goldGlow: "oklch(0.78 0.14 88 / 0.45)",
  navy700: "oklch(0.38 0.10 262)",
  marble50: "oklch(0.985 0.003 264)",
  white: "oklch(0.99 0 0)",
  ok: "oklch(0.62 0.15 150)",
  no: "oklch(0.58 0.20 27)",
} as const;

export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 450, // 15s
} as const;
