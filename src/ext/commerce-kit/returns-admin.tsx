import { getDB } from "@/lib/cf";
import { canEditCurrentPage } from "@/lib/access-guards";
import { OPEN_PARAM, parseRecordSearch, recordSearchParams } from "../record-search";
import { isReturnStatus, type ReturnStatus, type ShopReturn } from "./returns";
import { createReturnsEngine, isMissingTableError, type ReturnsConfig } from "./returns-engine";
import { ReturnsWorkspace } from "./ReturnsWorkspace";

// commerce-kit 1.50.0:退貨管理 adminPage 的 server 端(載入列表與各狀態筆數)。
// extension 只要給表名與網址:
//
//   component: ({ searchParams }) => (
//     <ReturnsAdminPage extId="shop" slug="returns" config={...} ordersPage="/admin/ext/shop" searchParams={searchParams} />
//   )
//
// 表還沒建(extension 更新了但還沒按「套用更新」)時不丟錯,畫面請店家先套用。
// 1.52.0:只能看這一頁的角色(canEditCurrentPage())沒有新增退貨與下一步。

const LIST_LIMIT = 200;
const PARAM_MAX = 60;

export async function ReturnsAdminPage({
  extId,
  slug,
  config,
  ordersPage,
  searchParams,
}: {
  extId: string;
  /** 這一頁的 adminPage slug。 */
  slug: string;
  config: ReturnsConfig;
  /** 訂單後台頁(明細裡的訂單編號連過去,帶 ?q= 搜尋)。 */
  ordersPage: string;
  searchParams: Record<string, string>;
}) {
  const raw = searchParams.status ?? "";
  const status: ReturnStatus | null = isReturnStatus(raw) ? raw : null;
  const search = parseRecordSearch(new URLSearchParams(searchParams));
  const engine = createReturnsEngine(getDB(), config);
  const canEdit = await canEditCurrentPage();
  let rows: ShopReturn[] = [];
  let counts: Partial<Record<ReturnStatus, number>> = {};
  let ready = true;
  try {
    [rows, counts] = await Promise.all([
      engine.list({ status: status ?? undefined, search, limit: LIST_LIMIT }),
      engine.counts(search),
    ]);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    ready = false;
  }
  const param = (key: string) => searchParams[key]?.trim().slice(0, PARAM_MAX) || null;
  return (
    <ReturnsWorkspace
      rows={rows}
      counts={counts}
      status={status}
      search={recordSearchParams(search).toString()}
      ready={ready}
      limit={LIST_LIMIT}
      endpoint={`/api/ext/${extId}`}
      pageHref={`/admin/ext/${extId}/${slug}`}
      ordersPage={ordersPage}
      statusRef={`${extId}:returns`}
      openNo={param(OPEN_PARAM)}
      orderNo={canEdit ? param("order") : null}
      canEdit={canEdit}
    />
  );
}
