// Static import map for OG image templates.
//
// Turbopack cannot resolve fully dynamic import paths (e.g.
// `import(\`./${name}.tsx\`)`), so each OGImageCN template is imported
// statically here and exposed through a single record. The OG API route and
// any consumer look up by template slug; an unknown slug yields `undefined`
// (caller returns 404).

import type { ComponentType } from "react";
import { Blog } from "./blog";
import { Changelog } from "./changelog";
import { Editorial } from "./editorial";
import { Event } from "./event";
import { Grid } from "./grid";
import { Logo } from "./logo";
import { Owner } from "./owner";
import { Photo } from "./photo";
import { Product } from "./product";
import { Profile } from "./profile";
import { Quote } from "./quote";
import { Shiori } from "./shiori";
import { Showcase } from "./showcase";
import { Simple } from "./simple";
import { Stat } from "./stat";
import { Terminal } from "./terminal";

export const OG_TEMPLATES: Record<string, ComponentType<Record<string, unknown>>> = {
  blog: Blog as unknown as ComponentType<Record<string, unknown>>,
  changelog: Changelog as unknown as ComponentType<Record<string, unknown>>,
  editorial: Editorial as unknown as ComponentType<Record<string, unknown>>,
  event: Event as unknown as ComponentType<Record<string, unknown>>,
  grid: Grid as unknown as ComponentType<Record<string, unknown>>,
  logo: Logo as unknown as ComponentType<Record<string, unknown>>,
  owner: Owner as unknown as ComponentType<Record<string, unknown>>,
  photo: Photo as unknown as ComponentType<Record<string, unknown>>,
  product: Product as unknown as ComponentType<Record<string, unknown>>,
  profile: Profile as unknown as ComponentType<Record<string, unknown>>,
  quote: Quote as unknown as ComponentType<Record<string, unknown>>,
  shiori: Shiori as unknown as ComponentType<Record<string, unknown>>,
  showcase: Showcase as unknown as ComponentType<Record<string, unknown>>,
  simple: Simple as unknown as ComponentType<Record<string, unknown>>,
  stat: Stat as unknown as ComponentType<Record<string, unknown>>,
  terminal: Terminal as unknown as ComponentType<Record<string, unknown>>,
};

export function getOgTemplate(
  slug: string,
): ComponentType<Record<string, unknown>> | undefined {
  return OG_TEMPLATES[slug];
}
