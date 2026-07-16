// Shared Paper & Ink recipes for the dashboard surfaces. Centralised so every
// card speaks the same language (shadow-ring over borders, concentric radii,
// dither-blue accent). See docs/admin-design-language.md.

// The login card recipe: a 1px hairline ring + two soft layered shadows on
// white. This replaces solid gray borders as the source of depth.
export const SHADOW_RING =
  "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]";

// Hover lift for interactive cards — slightly deeper ambient, no layout shift.
export const SHADOW_RING_HOVER =
  "hover:shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_6px_-2px_rgba(0,0,0,0.08),0_8px_20px_-8px_rgba(30,20,50,0.10)]";

// The dither blue — the ONLY accent. rgb(86,114,228).
export const ACCENT = "rgb(86,114,228)";
