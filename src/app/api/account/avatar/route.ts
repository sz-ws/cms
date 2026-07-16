import { eq } from "drizzle-orm";
import { requireAuth, authErrorResponse } from "@/lib/auth";
import { assertSameOrigin, originErrorResponse } from "@/lib/security";
import { hitRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { putFile, deleteFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

// 使用者頭像自助上傳/移除。任何登入角色皆可呼叫,但只能操作「自己」的
// users row(user.id 來自 requireAuth() 的 session,不接受 body/路徑帶入的
// 別人 id —— 沒有 [id] 路由參數,設計上就排除了操作他人的可能)。
//
// 走 lib/storage.ts 的 putFile/deleteFile 原生 primitive(不經 ext services 的
// ScopedStorage——那個 scope 綁 extId,語意是「extension 專屬」;頭像是 core
// 帳號功能,比照 src/app/api/media/delete/route.ts 直接呼叫 storage 層的慣例)。
// scope 固定 "avatars",與 media/upload 的 "core"、extension 的 <extId> 區隔。

const MAX_BYTES = 2 * 1024 * 1024; // 2MB —— 頭像遠小於一般媒體庫上傳(media/upload 25MB)。

// content-type 白名單 + 副檔名交叉驗證(雙重檢查,任一不符即拒絕):
// 只信任 File.type 這個 header 是不夠的(呼叫端可任意宣告),額外要求副檔名
// 落在該 content-type 允許的集合內,防止如 "innocuous.png" 但宣告
// application/octet-stream、或反過來檔名帶不相干副檔名的邊界情況。
const EXT_FOR_TYPE: Record<string, ReadonlySet<string>> = {
  "image/png": new Set(["png"]),
  "image/jpeg": new Set(["jpg", "jpeg"]),
  "image/webp": new Set(["webp"]),
};

function fileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** content-type 是白名單成員,且檔名副檔名與該 content-type 相符 → true。 */
function isAllowedImage(file: File): boolean {
  const contentType = file.type.toLowerCase();
  const allowedExts = EXT_FOR_TYPE[contentType];
  if (!allowedExts) return false;
  return allowedExts.has(fileExt(file.name));
}

/** 舊頭像刪除失敗不可擋新頭像已成功寫入/落庫這件事 —— 只 log,不 throw。 */
async function bestEffortDeleteAvatar(key: string): Promise<void> {
  try {
    await deleteFile(key);
  } catch (e) {
    console.error(`[account:avatar] failed to delete old avatar key=${key}`, e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let user;
  try {
    user = await requireAuth("guest"); // 帳號自身端點:guest 也能管理自己的頭像。
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  if (
    await hitRateLimit(user.id, {
      namespace: "account-avatar",
      limit: 10,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "empty_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }
  if (!isAllowedImage(file)) {
    return Response.json({ error: "invalid_type" }, { status: 415 });
  }

  // 更新前先讀出目前 avatarKey,更新後 best-effort 刪掉舊檔。
  const [existing] = await db()
    .select({ avatarKey: users.avatarKey })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const previousKey = existing?.avatarKey ?? null;

  const ext = fileExt(file.name);
  const stored = await putFile(
    "avatars",
    `${user.id}-${Date.now()}.${ext}`,
    file,
    file.type,
  );

  await db()
    .update(users)
    .set({ avatarKey: stored.key })
    .where(eq(users.id, user.id));

  if (previousKey && previousKey !== stored.key) {
    await bestEffortDeleteAvatar(previousKey);
  }

  return Response.json({
    ok: true,
    avatarKey: stored.key,
    avatarUrl: `/api/files/${stored.key}`,
  });
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    const r = originErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let user;
  try {
    user = await requireAuth("guest"); // 帳號自身端點:guest 也能移除自己的頭像。
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }

  if (
    await hitRateLimit(user.id, {
      namespace: "account-avatar",
      limit: 10,
      windowMs: 60_000,
    })
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const [existing] = await db()
    .select({ avatarKey: users.avatarKey })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const previousKey = existing?.avatarKey ?? null;

  await db().update(users).set({ avatarKey: null }).where(eq(users.id, user.id));

  if (previousKey) {
    await bestEffortDeleteAvatar(previousKey);
  }

  return Response.json({ ok: true });
}
