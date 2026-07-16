import { requireAuth } from "@/lib/auth";
import { getLocale, getMessages } from "@/lib/i18n/server";
import { listFiles } from "@/lib/storage";
import { MediaLibrary } from "./MediaLibrary";

export const dynamic = "force-dynamic";

// Task #7: /admin/media — first-class asset library. Server component shell:
// fetches the first page of the global library directly via lib/storage.ts
// (same call GET /api/media/list makes) so the grid paints with data on first
// load, then hands off to the client MediaLibrary for upload/search/selection/
// pagination/delete. requireAuth("admin") matches the other admin-only pages
// (Users, Settings write actions); the (admin) layout already gates session
// auth for every route under it.
export default async function MediaPage() {
  await requireAuth("admin");

  const locale = await getLocale();
  const m = getMessages(locale);
  const { files, cursor } = await listFiles("");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[21px] font-semibold tracking-[-0.015em] text-black/90">
          {m["media.title"]}
        </h1>
        <p className="text-[12px] text-black/35">
          {m["media.subtitle"]}
        </p>
      </div>

      <MediaLibrary initialFiles={files} initialCursor={cursor} />
    </div>
  );
}
