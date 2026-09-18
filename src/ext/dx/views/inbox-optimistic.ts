import type { SubmissionState } from "../submission";
import type { InboxRowDTO } from "./InboxTable";

// 收件匣的樂觀更新(InboxTable)。按下去先把列畫成結果,server 回來再由
// router.refresh() 的新資料接手;失敗時 transition 結束,列表自己退回原狀。
//
// patch 的語意照抄 server(src/ext/dx/crud.ts 的 inbox 路由 +
// src/lib/submissions.ts):先套 replied(未讀被標已回覆會順便變已讀),再套明確指定的
// state —— 兩邊算出同一個結果,refresh 回來時畫面才不會跳。

export type InboxAction =
  | {
      kind: "patch";
      id: string;
      state?: SubmissionState;
      replied?: boolean;
      /** 標記已回覆的時間(epoch ms);reducer 必須是純函式,時間由呼叫端帶進來。 */
      at: number;
    }
  | { kind: "delete"; id: string };

export function applyInboxAction(
  rows: readonly InboxRowDTO[],
  action: InboxAction,
): InboxRowDTO[] {
  if (action.kind === "delete") return rows.filter((r) => r.id !== action.id);
  return rows.map((r) => {
    if (r.id !== action.id) return r;
    let { state, repliedAt } = r;
    if (action.replied !== undefined) {
      repliedAt = action.replied ? action.at : null;
      if (action.replied && state === "unread") state = "read";
    }
    if (action.state !== undefined) state = action.state;
    return { ...r, state, repliedAt };
  });
}
