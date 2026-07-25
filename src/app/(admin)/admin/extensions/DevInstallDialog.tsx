"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, FlaskConical, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { describeInstallError } from "./useInstallFlow";

// 開發模式的 manifest 撰寫迴圈。
//
// 正式安裝路徑要求 manifest 出現在某個已註冊 registry source 的 https raw URL
// 上(SSRF 護欄,見 /api/registry/install),於是「寫自己的 manifest」變成每改
// 一次就要 push 一次。而 manifest 是這套系統的產品本體,那條迴圈斷掉代價很高。
//
// 這個入口與 POST /api/registry/install 的 inline 分支成對:兩邊都由
// `process.env.NODE_ENV !== "production"` 守住,而該判斷在 build 時被靜態求值,
// 所以**這個元件不會被打包進正式 bundle**。刻意不做成執行期旗標——一條繞過
// SSRF 護欄的路徑,唯一可接受的閘門是「它在正式環境根本不存在」。
//
// 字串刻意硬編碼英文、不進 i18n 字典:這些字永遠不會出現在使用者面前,
// 把它們塞進 en/zh-Hant 只會讓字典多兩打永遠翻不到的鍵。

const PLACEHOLDER = `{
  "kind": "declarative",
  "id": "recipes",
  "name": "Recipes",
  "version": "1.0.0",
  "coreApi": "^1.0.0",
  "contentTypes": [ ... ]
}`;

export function DevInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function install() {
    setError(null);

    // 先在 client 擋掉 JSON 語法錯誤 —— 那是撰寫迴圈裡最常見的失敗,
    // 讓它變成即時回饋而不是一次 round-trip。manifest 的**語意**驗證
    // 一律留給 server(parseManifest),這裡不做任何形狀判斷。
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      setError(`Not valid JSON: ${e instanceof Error ? e.message : "parse failed"}`);
      return;
    }
    const id = (manifest as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0) {
      setError("Manifest has no `id`.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/registry/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, manifest }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(describeInstallError(body));
        return;
      }
      onOpenChange(false);
      setText("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install manifest from JSON</DialogTitle>
          <DialogDescription>
            Development only — this bypasses the registry so you can iterate on a
            manifest without publishing it. The manifest itself is validated
            exactly as it would be coming from a registry.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          rows={16}
          className="font-mono text-[12.5px] leading-relaxed"
        />

        {error ? (
          <p className="flex items-start gap-1.5 text-[12.5px] text-red-700">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-black/40">
            Declaring <code className="font-mono">stylesheet</code> is not
            supported here — there is no source to fetch it from.
          </p>
          <Button onClick={install} disabled={busy || text.trim().length === 0}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Install
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Dev-only 觸發鈕。正式 build 回傳 null(整段連同 Dialog 一起被 DCE 掉)。 */
export function DevInstallTrigger() {
  const [open, setOpen] = useState(false);
  if (process.env.NODE_ENV === "production") return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-black/45 transition-colors hover:text-foreground"
        title="Development only"
      >
        <FlaskConical className="size-3.5" />
        From JSON
      </button>
      <DevInstallDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
