"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 共用 install 流程:FeaturedCard / StoreCard / ExtensionDetail 原本各自複製一份
// install() fetch 邏輯(見 git history);抽出這支 hook 後三處都改成呼叫它,行為
// 一致(含新的 installPrompts 表單流程)。
//
// 流程:click → GET /api/registry/manifest 預覽(admin-only,唯讀,cheap)→
//   manifest.installPrompts 非空 → 開 Dialog 收值 → 使用者送出 → POST /api/registry/install
//   帶 promptValues;
//   manifest.installPrompts 空/無 → 直接 POST /api/registry/install(沿用舊行為)。

export type InstallState = "idle" | "installing" | "installed" | "failed";

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
  onInstalled?: (id: string) => void,
) {
  const router = useRouter();
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

  async function postInstall(
    promptValues?: Record<string, unknown>,
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
        }),
      });
      if (res.ok) {
        setState("installed");
        setError(null);
        onInstalled?.(entry.id);
        router.refresh();
        return true;
      }
      setError(describeInstallError(await parseErrorBody(res)));
      setState("failed");
      return false;
    } catch {
      setError("Network error.");
      setState("failed");
      return false;
    }
  }

  /** Install/Get 按鈕的 onClick:先預覽 manifest,依 installPrompts 決定直接裝或開表單。 */
  async function install(): Promise<void> {
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
      manifest?: { installPrompts?: InstallPromptDef[] };
    };
    const installPrompts = json.manifest?.installPrompts ?? [];
    if (installPrompts.length > 0) {
      setPrompts(installPrompts);
      setState("idle"); // 等使用者填表單;按鈕先回到非 installing 視覺
      return;
    }
    await postInstall();
  }

  /** Dialog 送出:帶 promptValues 呼叫 install。 */
  async function submitPrompts(values: Record<string, unknown>): Promise<void> {
    setState("installing");
    setError(null);
    const ok = await postInstall(values);
    if (ok) setPrompts(null);
  }

  function closePrompts(): void {
    setPrompts(null);
    setState("idle"); // installed 顯示由上面的 props 推導接手
    setError(null);
  }

  return { state, error, prompts, install, submitPrompts, closePrompts };
}
