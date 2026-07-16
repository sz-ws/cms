"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// 客戶端小工具:以不可變方式改寫 URL searchParams。改 filter/sort/perPage 時
// 一律重設 page=1(換條件回第一頁),換頁時保留其餘條件。

export function useCollectionParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const commit = useCallback(
    (mutate: (params: URLSearchParams) => void, resetPage = true) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      if (resetPage) params.delete("page");
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null, resetPage = true) => {
      commit((p) => {
        if (value === null || value === "") p.delete(key);
        else p.set(key, value);
      }, resetPage);
    },
    [commit],
  );

  return { searchParams, setParam, commit };
}
