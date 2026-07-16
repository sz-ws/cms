import { PageTitle } from "@/components/ui/legacy";
import {
  DemoUniswap,
  DemoCarousel,
  DemoFeedback,
  DemoSchedule,
  DemoTabs,
} from "./demos";

/**
 * UI sandbox — 把已經落地在 src/components/ui/ 的 8 個新 component 並排展示。
 *
 * 目前先放在 admin/_ui-sandbox(底線開頭當 "hidden segment")給 admin 看。
 * 任何人都還沒決定哪個要去哪裡 / 哪個要進 declarative system;
 * 看完設計再決定。刪除這頁不影響任何 production 路由。
 */

type GroupMeta = {
  name: string;
  source: string;
  about: string;
  placement: string;
};

const GROUPS: GroupMeta[] = [
  {
    name: "Uniswap dialog",
    source: "registry.watermelon.sh/r/uniswap-dialog",
    about:
      "錢包 / swap 流程感的高階 dialog 容器 + step navigation + summary。非常適合長流程確認 modal。",
    placement: "platform ui — 還沒接進任何地方",
  },
  {
    name: "Carousel navigator",
    source: "registry.watermelon.sh/r/carousel-navigator",
    about:
      "carousels/hero/onboarding 用的 pagination navigator。進場有方向感,不是呆版 dots。",
    placement: "platform ui — 首頁 hero / onboarding 都適合",
  },
  {
    name: "Feedback action",
    source: "registry.watermelon.sh/r/feedback-action",
    about:
      "inline loading / error state 動畫,內建 retry。取代任何 setting 頁面的 idle 提示。",
    placement: "platform ui — settings / form action 都適合",
  },
  {
    name: "Schedule date",
    source: "registry.watermelon.sh/r/schedule-date",
    about:
      "雙月曆 + presets + 自訂 date range。取代 system 既有的 DateField。",
    placement: "platform ui — 可以跟既有 DateField 比較誰好",
  },
  {
    name: "Fluid tabs",
    source: "registry.watermelon.sh/r/fluid-tabs",
    about:
      "你『LOVE THIS TAB!』。滑順 spring 切換的 capsule tab。",
    placement: "platform ui — admin settings / extension tab",
  },
  // widget-2 / widget-4 / widget-6(storage / revenue / weekly-engagement)已
  // 畢業:延伸成 dashboard widget preset 家族(src/components/admin/dashboard/
  // widgets/,七款 preset)並接了真實資料進 /admin,不再是「還沒決定放哪」的
  // 展示品,故從這裡移除。
];

export default function UiSandboxPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <PageTitle>UI sandbox</PageTitle>
        <p className="text-[13px] text-black/55">
          Recent registry dumps (all live in <code>src/components/ui/</code>). Pick the vibe, then
          we wire it where it belongs.
        </p>
      </div>

      {GROUPS.map((g) => (
        <section
          key={g.name}
          className="rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_0_rgba(0,0,0,0.04)] p-5"
        >
          <header className="flex flex-col gap-1 pb-4">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
              {g.name}
            </h2>
            <p className="text-[12px] font-mono lowercase text-black/35">
              {g.source}
            </p>
            <p className="pt-1 text-[13px] leading-relaxed text-black/70">
              {g.about}
            </p>
            <p className="text-[12px] text-black/45">
              <span className="text-black/35">Possible placement ·</span>{" "}
              {g.placement}
            </p>
          </header>

          <div className="flex flex-wrap items-start gap-5 border-t border-black/[0.06] pt-5">
            {renderDemoFor(g.name)}
          </div>
        </section>
      ))}
    </div>
  );
}

function renderDemoFor(name: string) {
  if (name.startsWith("Uniswap")) return <DemoUniswap />;
  if (name.startsWith("Carousel")) return <DemoCarousel />;
  if (name.startsWith("Feedback")) return <DemoFeedback />;
  if (name.startsWith("Schedule")) return <DemoSchedule />;
  if (name.startsWith("Fluid")) return <DemoTabs />;
  return null;
}
