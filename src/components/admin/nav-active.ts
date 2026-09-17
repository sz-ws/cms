// 側欄「目前在哪一頁」的判定。純函式,與 AdminSidebar 分開是為了可以單獨測。
//
// 1.39.0 起改成**最長路徑勝出**:同一個 extension 的主頁是 /admin/ext/shop、
// 子頁是 /admin/ext/shop/verify,舊的逐項 startsWith 會讓兩個同時亮起。資料夾本身
// 不參與比對,只比對葉子。

export interface NavMatchItem {
  href: string;
  kind: string;
  children?: readonly NavMatchItem[];
}

export function pickActiveHref(
  items: readonly NavMatchItem[],
  pathname: string,
  tab: string | null,
): string | null {
  let bestHref: string | null = null;
  let bestLength = -1;
  const stack = [...items];
  while (stack.length > 0) {
    const item = stack.shift()!;
    if (item.children?.length) {
      stack.unshift(...item.children);
      continue;
    }
    const [path, query] = item.href.split("?");
    const matches =
      path === "/admin"
        ? pathname === "/admin"
        : pathname === path || pathname.startsWith(`${path}/`);
    if (!matches) continue;
    // 市集的兩個入口指向同一個路由:「瀏覽」只認 ?tab=browse,「已安裝」只認沒有 tab。
    if (item.kind === "shop") {
      const itemTab = query ? new URLSearchParams(query).get("tab") : null;
      if ((tab ?? null) !== itemTab) continue;
    }
    if (path.length > bestLength) {
      bestHref = item.href;
      bestLength = path.length;
    }
  }
  return bestHref;
}
