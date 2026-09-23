import { and, count, eq, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "./db";
import { staffRoles, users } from "./schema";
import {
  ROLE_NAME_MAX,
  parseStoredAccess,
  sanitizeAccess,
  type AccessMap,
  type PresetRole,
} from "@/ext/admin-access";

// 1.50.0:自訂角色的讀寫(migrations/0021_staff_roles.sql)。授權規則在
// ext/admin-access.ts;這裡只管資料 —— 名稱、access、誰在用。

export interface StaffRoleRecord {
  id: string;
  name: string;
  access: AccessMap;
  /** 使用這個角色的成員數。 */
  members: number;
  updatedAt: number;
}

export const staffRoleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(ROLE_NAME_MAX),
    access: z.record(z.string().max(200), z.enum(["view", "edit"])),
  })
  .strict();

export const staffRolePatchSchema = staffRoleInputSchema
  .partial()
  .refine((o) => o.name !== undefined || o.access !== undefined, { message: "empty_patch" });

export type StaffRoleInput = z.infer<typeof staffRoleInputSchema>;

export class StaffRoleError extends Error {
  constructor(public code: "not_found" | "name_taken") {
    super(code);
  }
}

export async function listStaffRoles(): Promise<StaffRoleRecord[]> {
  const [rows, counts] = await Promise.all([
    db().select().from(staffRoles).orderBy(staffRoles.createdAt),
    db()
      .select({ roleId: users.staffRoleId, n: count() })
      .from(users)
      .where(isNotNull(users.staffRoleId))
      .groupBy(users.staffRoleId),
  ]);
  const byRole = new Map(counts.map((c) => [c.roleId, c.n]));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    access: parseStoredAccess(row.access),
    members: byRole.get(row.id) ?? 0,
    updatedAt: row.updatedAt,
  }));
}

/** 預設角色各有幾位成員(有自訂角色的人不算在內)。 */
export async function presetMemberCounts(): Promise<Record<PresetRole, number>> {
  const rows = await db()
    .select({ role: users.role, n: count() })
    .from(users)
    .where(isNull(users.staffRoleId))
    .groupBy(users.role);
  const out: Record<PresetRole, number> = { admin: 0, editor: 0, guest: 0 };
  for (const row of rows) out[row.role] = row.n;
  return out;
}

export async function staffRoleExists(id: string): Promise<boolean> {
  const rows = await db()
    .select({ id: staffRoles.id })
    .from(staffRoles)
    .where(eq(staffRoles.id, id))
    .limit(1);
  return rows.length > 0;
}

/** 名稱不分大小寫、去頭尾空白後不能重複 —— 成員選單裡兩個「會計」分不出來。 */
async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const same = sql`lower(trim(${staffRoles.name})) = ${name.trim().toLowerCase()}`;
  const rows = await db()
    .select({ id: staffRoles.id })
    .from(staffRoles)
    .where(exceptId ? and(same, ne(staffRoles.id, exceptId)) : same)
    .limit(1);
  return rows.length > 0;
}

export async function createStaffRole(input: StaffRoleInput): Promise<StaffRoleRecord> {
  const name = input.name.trim();
  if (await nameTaken(name)) throw new StaffRoleError("name_taken");
  const access = sanitizeAccess(input.access);
  const now = Date.now();
  const id = nanoid();
  await db()
    .insert(staffRoles)
    .values({ id, name, access: JSON.stringify(access), createdAt: now, updatedAt: now });
  return { id, name, access, members: 0, updatedAt: now };
}

export async function updateStaffRole(
  id: string,
  patch: Partial<StaffRoleInput>,
): Promise<void> {
  if (!(await staffRoleExists(id))) throw new StaffRoleError("not_found");
  const set: Partial<{ name: string; access: string; updatedAt: number }> = {
    updatedAt: Date.now(),
  };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (await nameTaken(name, id)) throw new StaffRoleError("name_taken");
    set.name = name;
  }
  if (patch.access !== undefined) set.access = JSON.stringify(sanitizeAccess(patch.access));
  await db().update(staffRoles).set(set).where(eq(staffRoles.id, id));
}

/**
 * 刪角色:使用它的成員改成訪客(進不了後台),再刪角色 —— 同一個 batch,不會有
 * 「角色沒了、成員退回某個預設角色」的中間狀態。回傳改成訪客的人數。
 */
export async function deleteStaffRole(id: string): Promise<number> {
  if (!(await staffRoleExists(id))) throw new StaffRoleError("not_found");
  const [members] = await db()
    .select({ n: count() })
    .from(users)
    .where(eq(users.staffRoleId, id));
  await db().batch([
    db()
      .update(users)
      .set({ role: "guest", staffRoleId: null })
      .where(eq(users.staffRoleId, id)),
    db().delete(staffRoles).where(eq(staffRoles.id, id)),
  ]);
  return members?.n ?? 0;
}
