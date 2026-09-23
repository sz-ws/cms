"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/I18nProvider";
import type { DeclarativeScript } from "@/ext/dx/scripts";

// 共用 install 流程:FeaturedCard / StoreCard / ExtensionDetail 原本各自複製一份
// install() fetch 邏輯(見 git history);抽出這支 hook 後三處都改成呼叫它,行為
// 一致(含新的 installPrompts 表單流程)。
//
// 流程:click → GET /api/registry/manifest 預覽(admin-only,唯讀,cheap)→
//   manifest.installPrompts 非空 → 開 Dialog 收值 → 使用者送出 → POST /api/registry/install
//   帶 promptValues;
//   manifest.installPrompts 空/無 → 直接 POST /api/registry/install(沿用舊行為)。
// 1.48.0:manifest 帶 scripts 且這份內容還沒核准過 → 在 POST 之前(表單之後)開
//   ScriptReviewDialog,核准後帶 approveScripts(預覽回來的 hash)。來源沒開放 scripts
//   就在預覽這一步停下。

export type InstallState = "idle" | "installing" | "installed" | "failed";

/** 核准畫面要的資料(預覽 manifest 時就拿到)。 */
export interface ScriptReviewRequest {
  hash: string;
  scripts: DeclarativeScript[];
  /** 表單填的值;核准後原樣送出。 */
  promptValues?: Record<string, unknown>;
  /** 1.50.0:管理員已確認改用這個來源(見 install route 的 confirmSource)。 */
  confirmSource?: string;
}

interface PreviewScripts {
  hash: string;
  allowed: boolean;
  approved: boolean;
}

interface PreviewManifest {
  installPrompts?: InstallPromptDef[];
  scripts?: DeclarativeScript[];
}

interface Preview {
  manifest: PreviewManifest;
  scripts: PreviewScripts | null;
  confirmSource?: string;
}

export interface InstallPromptDef {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean";
  required?: boolean;
  secret?: boolean;
  description?: string;
}

interface InstallTarget {
  id: string;
  source: string;
  installed: boolean;
  /** 已安裝版本(index route 附帶;未安裝為 null)。 */
  installedVersion?: string | null;
  /** registry 上的最新版本。 */
  version?: string;
}

/** 已安裝但 registry 版本較新 → 按鈕該是可點的 "Update",不是鎖死的 "Installed"。 */
function hasUpdate(entry: InstallTarget): boolean {
  return (
    entry.installed &&
    entry.installedVersion != null &&
    entry.version !== undefined &&
    entry.installedVersion !== entry.version
  );
}

export function describeInstallError(body: Record<string, unknown>): string {
  const err = typeof body.error === "string" ? body.error : "install_failed";
  const message = typeof body.message === "string" ? body.message : undefined;
  const fields = Array.isArray(body.fields)
    ? (body.fields as unknown[]).filter((f): f is string => typeof f === "string")
    : undefined;
  switch (err) {
    case "unknown_source":
      return "Unknown registry source.";
    case "id_collision_with_code_extension":
      return "An installed code extension already uses this id.";
    case "invalid_manifest":
      return message ? `Invalid manifest: ${message}` : "Invalid manifest.";
    case "incompatible_core_api":
      return message ?? "Incompatible core API version.";
    case "missing_capabilities":
      return message ?? "Missing platform features.";
    case "manifest_fetch_failed":
      return message ? `Could not fetch manifest: ${message}` : "Could not fetch manifest.";
    case "migration_failed":
      return message ? `Migration failed: ${message}` : "Migration failed.";
    case "missing_prompt_values":
      return fields?.length
        ? `Missing required field${fields.length > 1 ? "s" : ""}: ${fields.join(", ")}`
        : "Missing required fields.";
    case "invalid_prompt_values":
      return fields?.length
        ? `Invalid value${fields.length > 1 ? "s" : ""} for: ${fields.join(", ")}`
        : "Invalid field values.";
    case "identity_mismatch":
      return message ?? "A different extension with this id is already installed.";
    case "source_changed":
      return message ?? "This extension was installed from another source.";
    case "missing_extensions":
      return message ?? "Required extensions are not installed and enabled.";
    case "rate_limited":
      return "Too many requests. Try again in a minute.";
    case "invalid_input":
      return "Invalid request.";
    case "bad_origin":
      return "Request blocked (bad origin).";
    case "unauthorized":
    case "forbidden":
      return "Not allowed.";
    default:
      return "Install failed.";
  }
}

async function parseErrorBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function useInstallFlow(
  entry: InstallTarget,
  /** 安裝/更新成功後通知擁有 registry data 的上層,讓列表/detail 兩個視圖即時同步。 */
  onInstalled?: (id: string, source: string) => void,
  /** 1.50.0:插件 id → 顯示名稱(錯誤訊息用;商店資料裡找得到名稱就不出現 id)。 */
  nameOf: (id: string) => string = (id) => id,
) {
  const router = useRouter();
  const t = useT();
  const [localState, setLocalState] = useState<InstallState>("idle");
  // 顯示狀態從 entry props 推導:上層同步 data 後,同一 extension 在其他視圖的
  // hook 實例(各自 localState 仍是 "idle")也會立刻翻成 "installed",不用等 reload。
  const state: InstallState =
    localState === "idle" && entry.installed && !hasUpdate(entry)
      ? "installed"
      : localState;
  const setState = setLocalState;
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<InstallPromptDef[] | null>(null);
  const [review, setReview] = useState<ScriptReviewRequest | null>(null);
  // 預覽拿到的 scripts 資訊;表單送出時決定要不要先開核准畫面。
  const [pending, setPending] = useState<Preview | null>(null);

  function scriptErrorMessage(body: Record<string, unknown>): string | null {
    if (body.error === "scripts_not_allowed") return t("scripts.notAllowed");
    if (body.error === "scripts_changed" || body.error === "scripts_review_required") {
      return t("scripts.changed");
    }
    return null;
  }

  // 1.50.0:插件身分與相依。商店畫面通常在按鈕之前就擋掉了,這裡接的是畫面資料過時
  // (例如另一個分頁剛停用了必要插件)的情況。
  function pluginErrorMessage(body: Record<string, unknown>): string | null {
    if (body.error === "identity_mismatch") return t("registryBrowser.plugins.conflict");
    if (body.error === "source_changed") return t("registryBrowser.error.sourceChanged");
    if (body.error === "missing_extensions") {
      const ids = Array.isArray(body.missing)
        ? body.missing.filter((id): id is string => typeof id === "string")
        : [];
      return t("registryBrowser.error.missingPlugins", { names: ids.map(nameOf).join("、") });
    }
    return null;
  }

  async function postInstall(
    promptValues?: Record<string, unknown>,
    approveScripts?: string,
    confirmSource?: string,
  ): Promise<boolean> {
    try {
      const res = await fetch("/api/registry/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          source: entry.source,
          ...(promptValues && Object.keys(promptValues).length > 0
            ? { promptValues }
            : {}),
          ...(approveScripts ? { approveScripts } : {}),
          ...(confirmSource ? { confirmSource } : {}),
        }),
      });
      if (res.ok) {
        setState("installed");
        setError(null);
        onInstalled?.(entry.id, entry.source);
        router.refresh();
        return true;
      }
      const body = await parseErrorBody(res);
      setError(scriptErrorMessage(body) ?? pluginErrorMessage(body) ?? describeInstallError(body));
      setState("failed");
      return false;
    } catch {
      setError("Network error.");
      setState("failed");
      return false;
    }
  }

  /** 表單之後(或沒有表單時)的下一步:需要核准就開核准畫面,否則直接裝。 */
  async function proceed(
    preview: Preview,
    promptValues?: Record<string, unknown>,
  ): Promise<boolean> {
    const scripts = preview.manifest.scripts;
    if (preview.scripts && scripts && !preview.scripts.approved) {
      setReview({ hash: preview.scripts.hash, scripts, promptValues, confirmSource: preview.confirmSource });
      setState("idle");
      return false;
    }
    return postInstall(promptValues, undefined, preview.confirmSource);
  }

  /**
   * Install/Get 按鈕的 onClick:先預覽 manifest,依 installPrompts 決定直接裝或開表單。
   * confirmSource(1.50.0):管理員已確認以這個來源取代從別的來源裝的舊版。
   */
  async function install(confirmSource?: string): Promise<void> {
    setError(null);
    setState("installing");
    let res: Response;
    try {
      res = await fetch(
        `/api/registry/manifest?source=${encodeURIComponent(entry.source)}&id=${encodeURIComponent(entry.id)}`,
      );
    } catch {
      setState("failed");
      setError("Network error.");
      return;
    }
    if (!res.ok) {
      setState("failed");
      setError(describeInstallError(await parseErrorBody(res)));
      return;
    }
    const json = (await res.json().catch(() => ({}))) as {
      manifest?: PreviewManifest;
      scripts?: PreviewScripts | null;
    };
    const preview: Preview = { manifest: json.manifest ?? {}, scripts: json.scripts ?? null, confirmSource };
    if (preview.scripts && !preview.scripts.allowed) {
      setState("failed");
      setError(t("scripts.notAllowed"));
      return;
    }
    setPending(preview);
    const installPrompts = preview.manifest.installPrompts ?? [];
    if (installPrompts.length > 0) {
      setPrompts(installPrompts);
      setState("idle"); // 等使用者填表單;按鈕先回到非 installing 視覺
      return;
    }
    await proceed(preview);
  }

  /** Dialog 送出:帶 promptValues 往下走(需要時先開核准畫面)。 */
  async function submitPrompts(values: Record<string, unknown>): Promise<void> {
    setState("installing");
    setError(null);
    const ok = await proceed(pending ?? { manifest: {}, scripts: null }, values);
    // 裝好了、或換成核准畫面了,表單都該收起來。
    if (ok || (pending?.scripts && !pending.scripts.approved)) setPrompts(null);
  }

  function closePrompts(): void {
    setPrompts(null);
    setState("idle"); // installed 顯示由上面的 props 推導接手
    setError(null);
  }

  /** 核准畫面的最後一步:帶著看過的 hash 安裝。 */
  async function confirmReview(): Promise<void> {
    if (!review) return;
    setState("installing");
    setError(null);
    const ok = await postInstall(review.promptValues, review.hash, review.confirmSource);
    if (ok) setReview(null);
  }

  function closeReview(): void {
    setReview(null);
    setState("idle");
    setError(null);
  }

  return {
    state,
    error,
    prompts,
    install,
    submitPrompts,
    closePrompts,
    review,
    confirmReview,
    closeReview,
  };
}
