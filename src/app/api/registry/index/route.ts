import { requireAuth, authErrorResponse } from "@/lib/auth";
import { fetchRegistryIndex } from "@/lib/registry-client";
import { db } from "@/lib/db";
import {
  extensions as extTable,
  declarativeExtensions as dxTable,
} from "@/lib/schema";
import { satisfies } from "@/ext/semver";
import { CORE_API_VERSION } from "@/ext/version";
import { availableServices } from "@/ext/service-requirements";
import { getExtRuntime } from "@/ext/loader";

export const dynamic = "force-dynamic";

// core-v2 §3.4:GET /api/registry/index。admin only。
// 對每個 configured source 抓 registry.json,merge entries,並附上
// installed?/installedVersion/compatible 供 Browse tab 使用。
export async function GET(): Promise<Response> {
  try {
    await requireAuth("admin");
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const { entries, errors } = await fetchRegistryIndex();

  const codeRows = await db().select().from(extTable);
  const dxRows = await db().select().from(dxTable);
  const codeVersionById = new Map(codeRows.map((r) => [r.id, r.version]));
  const dxVersionById = new Map(dxRows.map((r) => [r.id, r.version]));

  const items = entries.map((entry) => {
    const installedVersion =
      entry.kind === "code"
        ? codeVersionById.get(entry.id)
        : dxVersionById.get(entry.id);
    return {
      ...entry,
      installed: installedVersion !== undefined,
      installedVersion: installedVersion ?? null,
      compatible: satisfies(CORE_API_VERSION, entry.coreApi),
    };
  });

  // manifest.requires 的滿足判定基準:目前有 provider 的 capability 全集
  // (RegistryBrowser 對照 entry.requires 算 met/unmet)。
  const services = await availableServices();

  // installedCode:上面 codeVersionById 只反映 extensions 表(可能落後於實際
  // bundle,例如 registry.ts 加了新項但還沒跑過 install/enable 寫入 DB 列)。
  // rt.all(= extensions/registry.ts 的 registry 陣列,loader.ts 定義)才是「這次
  // 部署真的編譯進 bundle」的事實來源,version 取自 Extension 本身而非 DB 列
  // ——讓 Browse tab 能拿 entry.version(registry.json 上游)跟這裡的
  // bundle-compiled version 比對,判斷「已安裝但可更新」。enabled 仍查 DB 列
  // (loader 只把 enabled=1 的塞進 rt.enabled,故已編譯但停用的 code ext 要靠
  // codeRows 補上 enabled:false,不能只看 rt.enabled)。
  const enabledCodeIds = new Set(
    codeRows.filter((r) => r.enabled === 1).map((r) => r.id),
  );
  const rt = await getExtRuntime();
  const installedCode = rt.all.map((e) => ({
    id: e.id,
    version: e.version,
    enabled: enabledCodeIds.has(e.id),
  }));

  return Response.json({ entries: items, errors, services, installedCode });
}
