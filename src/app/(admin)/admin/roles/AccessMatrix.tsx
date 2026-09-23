"use client";

import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { levelOf, type AccessLevel, type AccessMap, type AccessSection } from "@/ext/admin-access";
import { useT } from "@/lib/i18n/I18nProvider";
import { AccessSegmented } from "./AccessSegmented";
import { sectionLevel, sectionMax } from "./roles-draft";

// 角色的權限矩陣:依側欄分區分組,每區一列標題(整區設定)+ 一頁一列。
// 標籤欄固定寬、控制項緊跟在後 —— 不把標籤推到最左、值推到最右;整張表的
// 分段按鈕上下對齊。

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 sm:grid-cols-[minmax(0,16rem)_auto] sm:justify-start";

export function AccessMatrix({
  sections,
  access,
  readOnly,
  onArea,
  onSection,
}: {
  sections: readonly AccessSection[];
  access: AccessMap;
  readOnly: boolean;
  onArea?: (area: AccessSection["areas"][number], level: AccessLevel) => void;
  onSection?: (section: AccessSection, level: AccessLevel) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col">
      {sections.map((section, index) => {
        // 整區控制只在兩頁以上才有用;只有一頁時它和那一列是同一件事,畫兩次只是雜訊。
        const grantable = section.areas.filter((area) => !area.locked).length > 1;
        return (
          <section
            key={section.id}
            aria-labelledby={`access-section-${section.id}`}
            className={cn("flex flex-col py-3", index > 0 && "border-t border-ink/[0.06]")}
          >
            <div className={cn(ROW, "pb-1.5")}>
              <h3
                id={`access-section-${section.id}`}
                className="truncate text-[12.5px] font-semibold text-ink/50"
              >
                {section.label}
              </h3>
              {grantable && (
                <AccessSegmented
                  quiet
                  value={sectionLevel(access, section)}
                  max={sectionMax(section)}
                  disabled={readOnly}
                  label={t("roles.setSection", { section: section.label })}
                  onChange={(level) => onSection?.(section, level)}
                />
              )}
            </div>
            <ul className="flex flex-col">
              {section.areas.map((area, i) => (
                <li
                  key={`${area.key}:${i}`}
                  className={cn(ROW, "min-h-9 rounded-[calc(8px*var(--admin-radius-scale,1))] py-1")}
                >
                  <span className="min-w-0 truncate text-[13.5px] text-ink/80">
                    {area.folder && <span className="text-ink/35">{area.folder} · </span>}
                    {area.title}
                  </span>
                  {area.locked ? (
                    <span className="inline-flex h-7 w-[9.5rem] items-center justify-center gap-1.5 text-[12px] text-ink/35">
                      <Lock aria-hidden className="size-3" />
                      {t("roles.adminOnly")}
                    </span>
                  ) : (
                    <AccessSegmented
                      value={levelOf(access, area.key)}
                      max={area.max}
                      disabled={readOnly}
                      label={area.folder ? `${area.folder} · ${area.title}` : area.title}
                      onChange={(level) => onArea?.(area, level)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
