import { notFound } from "next/navigation";
import { getExtRuntime } from "@/ext/loader";

export const dynamic = "force-dynamic";

// 03 §6c:公開路由 dispatch。必須用必填 catch-all [...slug]
// (同層存在 (public)/page.tsx,用 optional [[...slug]] 會與 / 同特異度而 build error)。
//
// OG image metadata: declarative extensions that declare `og.image.template` are
// expected to provide their own `generateMetadata()` within an extension-specific
// route file (or via a future adaptive metadata middleware). The
// `/api/og/<extId>/<type>` endpoint itself is generic and stays in this file.
export default async function PublicPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const segments = slug;
  const rt = await getExtRuntime();
  for (const ext of rt.enabled)
    for (const route of ext.publicRoutes ?? []) {
      const m = route.match(segments);
      if (m) {
        const C = route.component;
        return <C params={m} />;
      }
    }
  notFound();
}
