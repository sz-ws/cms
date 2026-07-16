"use client";

import type { ComponentType } from "react";
import type { AdminFormViewProps } from "./views/FormView";

// Fixed-entry layout registry.
//
// Any extension (code OR declarative) may ship a `layout.tsx` next to its
// manifest. The loader tries a dynamic import per extension id and, on
// success, registers the exported `Layout` component here under the key
// `<extId>.admin.form`.
//
// `FormView` consults this registry before rendering the generic baseline: a
// registered layout wins; otherwise we render the generic auto2col/single/
// manual form. This is the progressive "extension can fully customize the
// layout, runtime-usable by declarative extensions too" path — the manifest
// `layout` declaration stays as the lighter-weight option for extensions that
// only need to pick between generic kinds.

export type LayoutComponentProps = AdminFormViewProps;

interface LayoutRegistryEntry {
  component: ComponentType<LayoutComponentProps>;
}

const registry = new Map<string, LayoutRegistryEntry>();

/** Register an extension's fixed-entry layout component. */
export function registerAdminFormLayout(
  extId: string,
  component: ComponentType<LayoutComponentProps>,
): void {
  registry.set(`${extId}.admin.form`, { component });
}

/** Test whether a layout is registered for an extension. */
export function hasAdminFormLayout(extId: string): boolean {
  return registry.has(`${extId}.admin.form`);
}

/** Look up a registered layout component (or undefined → caller falls back to generic). */
export function getAdminFormLayout(
  extId: string,
): ComponentType<LayoutComponentProps> | undefined {
  return registry.get(`${extId}.admin.form`)?.component;
}
