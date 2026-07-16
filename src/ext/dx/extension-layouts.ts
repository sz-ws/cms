"use client";

import { registerAdminFormLayout, type LayoutComponentProps } from "./layout-registry";
import type { ComponentType } from "react";

// Client-side static imports of every extension's layout.tsx.
// The server registry (extensions/registry.ts) only reaches the server bundle
// via loader.ts. AdminFormSurface is a CLIENT component and reads a separate
// client-side Map, so we must statically import each layout here to pull it
// into the client bundle. Missing entry = client registry empty = generic
// FormView fallback (which is correct behaviour for extensions with no custom
// layout).
// Turbopack can't do dynamic `import(\`@/extensions/${id}/layout\`)`, so this
// is an explicit per-extension list — same maintenance shape as the server
// registry, just for the client graph.
import "../../../extensions/blog/layout";

// Fixed-entry layout registration helper for client use.
//
// Contract: an extension that wants to fully customize its admin form layout
// ships a `layout.tsx` (or any module) that exports a `Layout` component and,
// at module load, calls `registerExtensionLayout("<extId>", Layout)`. Code
// extensions do this from their bundle (the module is imported at build time,
// so registration happens before any form renders). Declarative extensions
// can't ship code at runtime, so they reuse a layout registered by a code
// extension by pointing their manifest at the same ext id — or they fall back
// to the generic FormView (auto2col / single / manual).
//
// Why no dynamic import here: Turbopack can't resolve a fully dynamic path
// like `@/extensions/${id}/layout.tsx`, and we don't want to enumerate every
// extension at build time. Self-registration from each extension's own module
// is the bundler-friendly equivalent and matches the existing override
// registry pattern (src/ext/overrides.ts).

export function registerExtensionLayout(
  extId: string,
  component: ComponentType<LayoutComponentProps>,
): void {
  registerAdminFormLayout(extId, component);
}

// Re-export for extension authors: their `layout.tsx` files import
// `LayoutComponentProps` from "@/ext/dx/extension-layouts", not directly from
// the registry.
export type { LayoutComponentProps } from "./layout-registry";

// No-op mounted component kept for the AdminShell mount site; self-registration
// happens at module load, so this just guarantees the module is evaluated.
export function ExtensionLayoutLoader({ extIds }: { extIds: string[] }) {
  // extIds is accepted for API symmetry / future per-id eager loading; today
  // registration is load-time, so we intentionally don't read it.
  void extIds;
  return null;
}
