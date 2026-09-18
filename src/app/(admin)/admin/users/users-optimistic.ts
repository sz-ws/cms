import type { UserRecord } from "./UsersTable";

// 成員列表的樂觀更新(UsersTable)。先把變更畫到列表上,server 回來再由
// router.refresh() 帶回的 initialUsers 接手;失敗時 transition 結束,列表自己退回原狀。

export type UsersAction =
  | { kind: "upsert"; user: UserRecord }
  | { kind: "remove"; id: string };

export function applyUsersAction(
  users: readonly UserRecord[],
  action: UsersAction,
): UserRecord[] {
  if (action.kind === "remove") return users.filter((u) => u.id !== action.id);
  const i = users.findIndex((u) => u.id === action.user.id);
  if (i === -1) return [...users, action.user];
  const next = [...users];
  next[i] = action.user;
  return next;
}
