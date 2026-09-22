"use client";

import { useState } from "react";
import { Plus, Trash2, Check, AlertCircle, Loader2, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";

export interface RegistrySource {
  url: string;
  name?: string;
  icon?: string;
  /** 外送用:僅在使用者本次輸入新 token 時存在;server 端拆進加密儲存。 */
  token?: string;
  /** server 下發的旗標:此 source 已有已儲存(加密)的 token。token 本體絕不下發。 */
  hasToken?: boolean;
  /** 1.48.0:這個來源的插件可以帶前台 script(安裝時仍要逐一核准)。 */
  allowScripts?: boolean;
}

interface RegistrySourcesManagerProps {
  initialSources: RegistrySource[];
}

interface TestResult {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
}

export function RegistrySourcesManager({
  initialSources,
}: RegistrySourcesManagerProps) {
  const t = useT();
  const [sources, setSources] = useState<RegistrySource[]>(initialSources);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [newUrl, setNewUrl] = useState("");
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("");
  const [newToken, setNewToken] = useState("");
  const [newAllowScripts, setNewAllowScripts] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>({ status: "idle" });

  async function testConnection(url: string, token?: string): Promise<TestResult> {
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `token ${token}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${url}/registry.json`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return {
          status: "error",
          message: `HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const text = await res.text();
      JSON.parse(text);

      return { status: "success", message: t("registry.connectionSuccess") };
    } catch (e) {
      if (e instanceof Error) {
        if (e.name === "AbortError") {
          return { status: "error", message: t("registry.connectionTimeout") };
        }
        return { status: "error", message: e.message };
      }
      return { status: "error", message: t("registry.unknownError") };
    }
  }

  function openAddDialog() {
    setEditingIndex(null);
    setNewUrl("");
    setNewName("");
    setNewIcon("");
    setNewToken("");
    setNewAllowScripts(false);
    setTestResult({ status: "idle" });
    setDialogOpen(true);
  }

  function openEditDialog(index: number) {
    const source = sources[index];
    setEditingIndex(index);
    setNewUrl(source.url);
    setNewName(source.name ?? "");
    setNewIcon(source.icon ?? "");
    setNewToken(""); // token 不下發也不預填;留空 = 保留既有 token
    setNewAllowScripts(source.allowScripts === true);
    setTestResult({ status: "idle" });
    setDialogOpen(true);
  }

  async function handleTest() {
    if (!newUrl) return;

    setTestResult({ status: "testing" });
    const result = await testConnection(newUrl, newToken || undefined);
    setTestResult(result);
  }

  async function handleAddOrEdit() {
    if (!newUrl) return;

    const editing = editingIndex !== null ? sources[editingIndex] : null;
    const newSource: RegistrySource = {
      url: newUrl.endsWith("/") ? newUrl.slice(0, -1) : newUrl,
      name: newName || undefined,
      icon: newIcon || undefined,
      // token 只在使用者本次輸入時外送(server 拆進加密儲存);
      // 留空 + 原本有 token = server 端沿用既有 token。
      token: newToken || undefined,
      hasToken: newToken
        ? true
        : Boolean(editing?.hasToken && editing.url === newUrl),
      allowScripts: newAllowScripts || undefined,
    };

    let updatedPayload: RegistrySource[];
    if (editingIndex !== null) {
      updatedPayload = [...sources];
      updatedPayload[editingIndex] = newSource;
    } else {
      updatedPayload = [...sources, newSource];
    }

    // local state 不保留 token 明文(只留 hasToken 旗標)
    setSources(updatedPayload.map(({ token, ...rest }) => {
      void token;
      return rest;
    }));
    setNewUrl("");
    setNewName("");
    setNewIcon("");
    setNewToken("");
    setTestResult({ status: "idle" });
    setDialogOpen(false);
    setEditingIndex(null);

    // Auto-save
    await saveToServer(updatedPayload);
  }

  function handleDelete(index: number) {
    const updatedSources = sources.filter((_, i) => i !== index);
    setSources(updatedSources);
    saveToServer(updatedSources);
  }

  async function saveToServer(sourcesToSave: RegistrySource[]) {
    // 這裡原本有一組 saving / saveResult state,但它們從未被 render 用到(死狀態,
    // 也正是 lint 抓到的那條 error)。移除是對的 —— 但**不能連錯誤處理一起移除**:
    // 設定存檔失敗若完全無聲,使用者會以為存好了。可見的 UI 回饋是後續任務;在那
    // 之前至少要留下痕跡,而不是吞掉(見 rules:never silently swallow errors)。
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: {
            "core.registrySources": sourcesToSave,
          },
        }),
      });
      if (!res.ok) {
        console.error("[registry-sources] 儲存失敗", res.status);
      }
    } catch (e) {
      console.error("[registry-sources] 儲存請求失敗", e);
    }
  }

  function getDisplayName(source: RegistrySource): string {
    if (source.name) return source.name;
    try {
      const url = new URL(source.url);
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length >= 2) {
        return `${pathParts[0]}/${pathParts[1]}`;
      }
      return url.hostname;
    } catch {
      return source.url;
    }
  }

  function getDisplayUrl(source: RegistrySource): string {
    try {
      const url = new URL(source.url);
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (pathParts.length >= 1) {
        return `${url.hostname}/${pathParts[0]}`;
      }
      return url.hostname;
    } catch {
      return source.url;
    }
  }

  function getIcon(source: RegistrySource): React.ReactNode {
    if (source.icon) {
      if (source.icon.length <= 4) {
        return <span className="text-xl">{source.icon}</span>;
      }
      return <span className="text-xl">{source.icon}</span>;
    }
    return <span className="text-xl">🛍️</span>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink/90">
            {t("registry.title")}
          </h3>
          <p className="text-[12px] text-ink/40">{t("registry.desc")}</p>
        </div>
        <Button onClick={openAddDialog} className="gap-1.5" size="sm">
          <Plus className="size-4" />
          {t("registry.add")}
        </Button>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-[calc(14px*var(--admin-radius-scale,1))] border border-dashed border-ink/20 p-8 text-center">
          <p className="text-[13px] text-ink/45">{t("registry.noSources")}</p>
          <p className="mt-1 text-[12px] text-ink/35">
            {t("registry.noSourcesDesc")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((source, index) => (
            <div
              key={index}
              className="group flex items-center justify-between rounded-[calc(10px*var(--admin-radius-scale,1))] border border-ink/10 bg-surface px-4 py-3 transition-colors hover:border-ink/20"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[calc(8px*var(--admin-radius-scale,1))] bg-ink/[0.04] text-xl">
                  {getIcon(source)}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[14px] font-medium text-ink/85">
                    {getDisplayName(source)}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="truncate font-mono text-[11px] text-ink/40">
                      {getDisplayUrl(source)}
                    </code>
                    {source.allowScripts && (
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                        {t("registry.scriptsBadge")}
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => openEditDialog(index)}
                  className="rounded-[calc(6px*var(--admin-radius-scale,1))] p-1.5 text-ink/35 hover:bg-ink/[0.04] hover:text-ink/85"
                >
                  <Edit2 className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(index)}
                  className="rounded-[calc(6px*var(--admin-radius-scale,1))] p-1.5 text-ink/35 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md rounded-[calc(20px*var(--admin-radius-scale,1))] p-0 shadow-[var(--admin-shadow-panel,0_16px_48px_-12px_rgba(30,20,50,0.18))]">
          <div className="flex flex-col gap-4 p-5">
            <DialogHeader>
              <DialogTitle>
                {editingIndex !== null
                  ? t("registry.editSource")
                  : t("registry.addSource")}
              </DialogTitle>
              <DialogDescription>{t("registry.connectDesc")}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-ink/55">
                  {t("registry.displayName")}
                </label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("registry.namePlaceholder")}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-ink/55">
                  {t("registry.icon")}
                </label>
                <Input
                  value={newIcon}
                  onChange={(e) => setNewIcon(e.target.value)}
                  placeholder="🛍️"
                  className="text-center text-xl"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-ink/55">
                  {t("registry.registryUrl")}
                </label>
                <Input
                  value={newUrl}
                  onChange={(e) => {
                    setNewUrl(e.target.value);
                    setTestResult({ status: "idle" });
                  }}
                  placeholder="https://raw.githubusercontent.com/sz-ws/registry/main"
                  className="font-mono text-[13px]"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-ink/55">
                  {t("registry.accessToken")}
                </label>
                <Input
                  type="password"
                  value={newToken}
                  onChange={(e) => {
                    setNewToken(e.target.value);
                    setTestResult({ status: "idle" });
                  }}
                  placeholder={
                    editingIndex !== null && sources[editingIndex]?.hasToken
                      ? t("registry.tokenPlaceholder")
                      : t("registry.tokenHint")
                  }
                  className="font-mono text-[13px]"
                />
              </div>

              <label className="flex cursor-pointer items-start justify-between gap-3 pt-1">
                <span className="flex flex-col gap-0.5">
                  <span className="text-[12px] font-medium text-ink/70">
                    {t("registry.allowScripts")}
                  </span>
                  <span className="text-[11px] leading-relaxed text-ink/40">
                    {t("registry.allowScriptsHint")}
                  </span>
                </span>
                <Switch
                  checked={newAllowScripts}
                  onCheckedChange={setNewAllowScripts}
                />
              </label>
            </div>

            {testResult.status !== "idle" && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-[calc(8px*var(--admin-radius-scale,1))] px-3 py-2 text-[13px]",
                  testResult.status === "testing" && "bg-blue-50 text-blue-700",
                  testResult.status === "success" && "bg-green-50 text-green-700",
                  testResult.status === "error" && "bg-red-50 text-red-700"
                )}
              >
                {testResult.status === "testing" && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {testResult.status === "success" && <Check className="size-4" />}
                {testResult.status === "error" && <AlertCircle className="size-4" />}
                <span>{testResult.message}</span>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={!newUrl || testResult.status === "testing"}
                className="flex-1"
              >
                {testResult.status === "testing"
                  ? t("registry.testing")
                  : t("registry.testConnection")}
              </Button>
              <Button
                onClick={handleAddOrEdit}
                disabled={!newUrl}
                className="flex-1"
              >
                {editingIndex !== null ? t("registry.save") : t("registry.add")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
