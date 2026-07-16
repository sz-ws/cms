import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  // Optional isolated build dir so a second dev server can run alongside the
  // primary one without contending for the same `.next/dev` lock. Activated
  // only when CMS_DEV_DISTDIR is set; no effect on normal dev/build/deploy.
  ...(process.env.CMS_DEV_DISTDIR
    ? { distDir: process.env.CMS_DEV_DISTDIR }
    : {}),
};
export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
