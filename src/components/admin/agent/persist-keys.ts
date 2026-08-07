// docs/spec-admin-agent.md §5:面板 transcript 在 localStorage 的**位址**與清除。
//
// 這個檔存在的唯一理由是 **bundle 隔離**,不是概念分層。
//
// `clearAllStoredTranscripts` 掛在 AdminSidebar 的登出,而 AdminSidebar 每一頁 admin
// 都在。它若從 persist.ts 進來,就會把 persist.ts 的相依鏈(zod、agent-ask、
// agent-display、transcript)一起釘進 admin 的共用 chunk —— 為了一個「登出時刪幾個
// key」的動作,那個代價不成比例。
//
// 所以切法是照「需要知道什麼」切,而不是照「read/write 一組」切:
//
//   · 本檔 = **key 的形狀 + 刪除**。零相依,連型別 import 都沒有。刪一筆資料不需要
//     知道那筆資料長什麼樣。
//   · persist.ts = **序列化與驗證**。它才需要認識 TranscriptState,而它的消費者
//     (AgentPanel / AgentPanelLoader)本來就在 /admin/agent 自己的 chunk 上。
//
// 讀寫留在 persist.ts:那兩個真的需要 deserialize。

/**
 * key 的**根**前綴。clearAllStoredTranscripts 掃的是這一段,不是下面那個帶版本的
 * —— 版本跳號之後,舊世代留下來的 key 仍然要掃得到,否則它們會永遠躺在那裡。
 */
export const AGENT_TRANSCRIPT_KEY_ROOT = "sz.agent.transcript.";

/** 目前世代的完整前綴。格式改變時跳版本號,舊 key 自然對不上而被忽略。 */
export const AGENT_TRANSCRIPT_KEY_PREFIX = `${AGENT_TRANSCRIPT_KEY_ROOT}v1.`;

/**
 * 這個使用者的 key。
 *
 * **後綴綁 user id,而且刻意不是 email**:同一台機器換人登入時,key 對不上就撿不到
 * 上一個人的對話 —— 這是這個功能唯一真正的隔離手段(localStorage 本身沒有帳號概念)。
 * 用 id 而不是 email 是因為 key 名在 devtools 裡是明文的,而 id 是 nanoid 產的不透明
 * 字串,email 則是別人的帳號名稱。
 */
export function transcriptStorageKey(userId: string): string {
  return `${AGENT_TRANSCRIPT_KEY_PREFIX}${userId}`;
}

/** localStorage 存取一律包起來:Safari 的無痕模式**光是讀取就會 throw**。 */
export function withStorage<T>(fallback: T, run: (storage: Storage) => T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return run(window.localStorage);
  } catch {
    return fallback;
  }
}

export function clearStoredTranscript(key: string): void {
  withStorage(undefined, (storage) => storage.removeItem(key));
}

/**
 * 掃掉這個功能寫過的**所有** key(不分使用者、不分版本)。
 *
 * 掛在登出(AdminSidebar 的 onLogout)。為什麼是那裡而不是登入頁掛載時:登出是
 * 使用者**明確表示「我離開這台機器了」**的那個動作,而看到登入頁只代表 session 沒了
 * (逾時、換分頁、cookie 過期都算),把它當成「清掉本機資料」的訊號會過度反應。
 *
 * 換人登入撿到別人對話的那條路,不靠這裡,靠 key 綁 user id(見上)。這裡負責的是
 * 「我用完了」的那種乾淨。
 */
export function clearAllStoredTranscripts(): void {
  withStorage(undefined, (storage) => {
    // 先收集再刪:removeItem 會讓 key(i) 的索引位移,邊走邊刪一定漏。
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(AGENT_TRANSCRIPT_KEY_ROOT)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  });
}
