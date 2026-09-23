import type { LocalizedString } from "@/lib/i18n/localized";

// 1.50.0:插件的全域身分(identity)與插件之間的相依。純資料 + 純函式,server、
// client、install route、商店畫面共用同一份規則。
//
// ## 為什麼需要 identity
//
// 站內用來定址插件的是 id(content type 叫 `<id>.<type>`、設定叫 `ext.<id>.x`、
// migration 建的表、網址都用它)。id 只在一個來源裡唯一:兩個來源各發一個
// `catalog`,站台分不出來,從另一個來源「更新」會把原本那個整包換掉。identity 是
// 插件跨來源的名字,裝上之後就不能換;id 仍然是站內的 key,不變。
//
// ## 為什麼是「發行者/名稱」而不是 UUID
//
// 兩種都只是字串,沒有簽章就都能被照抄 —— UUID 並不比較難冒用,所以唯一的差別
// 是誰讀得懂。identity 會出現在別的插件的相依宣告、錯誤訊息、registry 的索引裡,
// 作者要手寫、管理員要看得懂「這是誰的東西」;`sz-ws/catalog` 一眼可辨,
// `3f1c…` 要查表。發行者段(組織代號或網域)讓不同發行者的同名插件天然不撞名,
// 而「一個發行者只能從它自己的來源發」這種綁定,日後加上簽章時也是用這個前綴
// 去對。形狀:`<publisher>/<name>`,publisher 是小寫英數以單一 `.` 或 `-` 分段
// (`sz-ws`、`example.com`),name 同插件 id 的規則(通常就等於 id,但不必)。
export const IDENTITY_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z][a-z0-9-]{1,30}$/;
export const IDENTITY_MAX = 96;

export function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length <= IDENTITY_MAX && IDENTITY_RE.test(value);
}

/** 一個插件宣告「需要另一個插件」。id 是站內 key;identity 有就一起比對。 */
export interface PluginRequirement {
  id: string;
  identity?: string;
  /** true = 沒有也能用,只是少一部分功能;不擋安裝。 */
  optional?: boolean;
  reason?: LocalizedString;
}

/** 站上已安裝的一個插件(判斷相依是否滿足用)。 */
export interface InstalledPlugin {
  id: string;
  kind: "code" | "declarative";
  enabled: boolean;
  identity?: string | null;
}

/**
 * met = 裝了也啟用;disabled = 裝了但停用;missing = 沒裝;different = 同 id 裝的是
 * 別的插件(兩邊都有 identity 而且不同)。
 *
 * 已安裝的那個沒有 identity(舊插件)時只能靠 id 判斷,當成同一個 —— 要求它有
 * identity 會讓所有舊安裝都算「缺少」,而那正是 identity 出現之前的每一個站。
 */
export type RequirementState = "met" | "disabled" | "missing" | "different";

export function requirementState(
  req: Pick<PluginRequirement, "id" | "identity">,
  installed: InstalledPlugin | undefined,
): RequirementState {
  if (!installed) return "missing";
  if (req.identity && installed.identity && installed.identity !== req.identity) return "different";
  return installed.enabled ? "met" : "disabled";
}

export interface UnmetRequirement {
  id: string;
  state: Exclude<RequirementState, "met">;
}

/** 非選用、而且沒滿足的相依(空陣列 = 可以裝 / 可以用)。 */
export function unmetRequirements(
  reqs: readonly PluginRequirement[] | undefined,
  installed: ReadonlyMap<string, InstalledPlugin>,
): UnmetRequirement[] {
  const out: UnmetRequirement[] = [];
  for (const req of reqs ?? []) {
    if (req.optional) continue;
    const state = requirementState(req, installed.get(req.id));
    if (state !== "met" && !out.some((u) => u.id === req.id)) out.push({ id: req.id, state });
  }
  return out;
}

/**
 * 啟用中、而且非選用地需要 target 的插件 —— 停用或移除 target 之前要先停用它們。
 * 「需要」的比法與 requirementState 一致:同 id,而且不是 identity 不同的另一個插件。
 */
export function requiredBy<T extends InstalledPlugin & { requires: readonly PluginRequirement[] }>(
  plugins: readonly T[],
  target: { id: string; identity?: string | null },
): T[] {
  const asInstalled: InstalledPlugin = { id: target.id, kind: "declarative", enabled: true, identity: target.identity };
  return plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.id !== target.id &&
      plugin.requires.some(
        (req) => !req.optional && req.id === target.id && requirementState(req, asInstalled) !== "different",
      ),
  );
}

/** 程式碼插件的 requiresExtensions(純 id 陣列)→ 統一的相依形狀。 */
export function codeRequirements(ids: readonly string[] | undefined): PluginRequirement[] {
  return (ids ?? []).map((id) => ({ id }));
}

/** `req` 指的是不是這個插件:兩邊都有 identity 就比 identity,否則比 id。 */
export function requirementTargets(
  req: Pick<PluginRequirement, "id" | "identity">,
  plugin: { id: string; identity?: string | null },
): boolean {
  if (req.identity && plugin.identity) return req.identity === plugin.identity;
  return req.id === plugin.id;
}

/**
 * 安裝或更新一個宣告式插件之前:同 id 已經裝了東西時,它是不是同一個插件、能不能直接換。
 *
 *   - 已安裝的有 identity:新來的必須一模一樣(少了也不行),確認也繞不過。
 *   - 來源不同 → 不自動覆蓋,要管理員明確確認(confirmedSource 等於當初的來源)。
 *     1.50.0 時 identity 相同就放行(registry 搬家);1.52.0 起一律要確認:identity 沒有
 *     簽章、誰都能照抄,付費插件出現之後,第二個 registry 列出同 id、同 identity、版本
 *     較高的東西,就能靜悄悄換掉一個付費插件。搬家的 registry 只是多按一次確認。
 *   - 已安裝的沒有 identity(1.50.0 之前裝的):同一個來源照舊更新(新版帶了 identity 就
 *     從此記下)。
 *   - 開發模式的 inline 安裝(source 為 null)或當初沒有記來源:不比來源。
 */
export type InstallVerdict =
  | { ok: true }
  | { ok: false; error: "identity_mismatch"; installed: string; incoming: string | null }
  | { ok: false; error: "source_changed"; installedSource: string };

export function installVerdict(
  installed: { identity?: string | null; source: string | null } | null,
  incoming: { identity?: string | null; source: string | null },
  confirmedSource?: string,
): InstallVerdict {
  if (!installed) return { ok: true };
  if (installed.identity && incoming.identity !== installed.identity) {
    return { ok: false, error: "identity_mismatch", installed: installed.identity, incoming: incoming.identity ?? null };
  }
  if (incoming.source === null || installed.source === null) return { ok: true };
  if (installed.source === incoming.source || confirmedSource === installed.source) return { ok: true };
  return { ok: false, error: "source_changed", installedSource: installed.source };
}

/**
 * 商店索引裡的一個項目是不是已安裝的那一個(index route 與商店畫面的「已安裝 / 衝突」)。
 * 1.52.0 起以 (來源, id) 為準:別的來源列出的同 id 項目一律是 source 衝突(卡片「已從
 * <主機> 安裝」、沒有更新鈕),就算 identity 相同 —— 規則同 installVerdict。
 *
 * 與 installVerdict 的差別只有一點:索引項目沒寫 identity,不代表那個插件沒有 ——
 * 索引常常落後 manifest(registry 的索引建置還沒帶這個欄位、第三方來源自己產的索引)。
 * 把「索引沒寫」當成「沒有」,作者一在 manifest 加上 identity,裝好之後商店就會說它跟
 * 自己衝突、叫管理員先移除。所以這裡只在兩邊都有 identity 時比 identity;缺一邊就當作
 * 不知道,只比來源。真正安裝時 install route 拿實際的 manifest 用 installVerdict 再判
 * 一次,這裡放過的不會變成覆蓋別人的插件。
 */
export function listingVerdict(
  installed: { identity?: string | null; source: string | null } | null,
  listing: { identity?: string | null; source: string | null },
): InstallVerdict {
  if (!installed) return { ok: true };
  if (installed.identity && listing.identity && listing.identity !== installed.identity) {
    return { ok: false, error: "identity_mismatch", installed: installed.identity, incoming: listing.identity };
  }
  return installVerdict({ identity: null, source: installed.source }, { identity: null, source: listing.source });
}
