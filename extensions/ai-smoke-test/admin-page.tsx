import { PromptForm } from "./PromptForm";

export async function AiSmokeTestAdminPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-black/85">
          AI Smoke Test
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-black/55">
          純測試用的最小 extension,不上 registry——只是要驗證
          ai:generate 這個 capability 從 extension 端(ctx.services.providers)
          真的能打通。要看到真的生成文字,先去設定頁的 Advanced 區填
          core.ai.mode/model/key。
        </p>
      </header>
      <PromptForm />
    </div>
  );
}
