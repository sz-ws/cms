"use client";

import { useState } from "react";
import { Check, Download, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/I18nProvider";

// 設定頁的「匯出內容」區塊(ApiTokensManager 的同一種切片:border-t 分隔 + 標題列 +
// 內容)。這一塊的存在本身就是承諾:資料拿得回去。所以文案講的是「檔案裡有什麼、
// 沒有什麼」,而不是格式術語。
//
// 為什麼是 form POST 而不是 fetch:
//   1. 端點是 POST(見 route 檔頭:同源檢查需要 Origin header,GET 不帶)。
//   2. form 送出讓瀏覽器**直接把回應串流寫進磁碟**。改用 fetch 就得
//      res.blob() 把整份匯出先塞進瀏覽器記憶體 —— 大站等於白做串流。
// 送出後瀏覽器因為 Content-Disposition: attachment 而留在原頁,不需要 target。
//
// 為什麼 form 是點擊當下才建、而不是寫在 JSX 裡:這張卡片被 SettingsWorkspace 的
// <form> 包住,巢狀 <form> 是不合法的 HTML。瀏覽器會把內層丟掉，於是 submit 鈕
// 會去送**設定表單**而不是匯出，同時 SSR/client 樹不一致造成 hydration 失敗。
// 建一個 detached form 送出，語意與原本的原生送出完全相同，但不進 React 樹。

const ALL = "__all__";

export interface ExportContentType {
  type: string;
  label: string;
}

interface ContentExportCardProps {
  types: ExportContentType[];
}

export function ContentExportCard({ types }: ContentExportCardProps) {
  const t = useT();
  const [type, setType] = useState<string>(ALL);

  const action =
    type === ALL ? "/api/export" : `/api/export?type=${encodeURIComponent(type)}`;

  function submitExport() {
    const form = document.createElement("form");
    form.method = "post";
    form.action = action;
    document.body.appendChild(form);
    try {
      form.submit();
    } finally {
      form.remove();
    }
  }

  const included = [
    t("export.included.entries"),
    t("export.included.media"),
    t("export.included.settings"),
  ];
  const excluded = [
    t("export.excluded.secrets"),
    t("export.excluded.users"),
    t("export.excluded.revisions"),
    t("export.excluded.mediaBytes"),
  ];

  return (
    <div className="flex flex-col gap-4 border-t border-black/[0.06] pt-6">
      <div>
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
          {t("export.title")}
        </h3>
        <p className="text-[12px] text-black/40">{t("export.desc")}</p>
      </div>

      <div className="rounded-[14px] bg-white p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)]">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <dt className="text-[12px] font-medium text-black/55">
              {t("export.includedTitle")}
            </dt>
            {included.map((line) => (
              <dd
                key={line}
                className="flex items-start gap-2 text-[12px] leading-relaxed text-black/45"
              >
                <Check className="mt-0.5 size-3.5 shrink-0 text-black/30" />
                <span>{line}</span>
              </dd>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="text-[12px] font-medium text-black/55">
              {t("export.excludedTitle")}
            </dt>
            {excluded.map((line) => (
              <dd
                key={line}
                className="flex items-start gap-2 text-[12px] leading-relaxed text-black/45"
              >
                <Minus className="mt-0.5 size-3.5 shrink-0 text-black/20" />
                <span>{line}</span>
              </dd>
            ))}
          </div>
        </dl>

        <div className="mt-4 flex flex-col gap-3 border-t border-black/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-end">
          <label
            htmlFor="export-scope"
            className="text-[13px] font-medium text-black/55 sm:mr-auto"
          >
            {t("export.scope")}
          </label>
          <Select
            value={type}
            onValueChange={(next) => setType(next ?? ALL)}
          >
            <SelectTrigger
              id="export-scope"
              className="w-full rounded-[8px] border-black/10 bg-white text-[14px] text-black/85 sm:w-64"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={ALL}>{t("export.scopeAll")}</SelectItem>
              {types.map((ct) => (
                <SelectItem key={ct.type} value={ct.type}>
                  {ct.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" onClick={submitExport} className="gap-1.5">
            <Download className="size-4" />
            {t("export.download")}
          </Button>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-black/30">
        {t("export.formatNote")}
      </p>
    </div>
  );
}
