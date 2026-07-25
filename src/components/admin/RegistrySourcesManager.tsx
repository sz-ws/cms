"use client";

import { useState } from "react";
import { Plus, Trash2, Check, AlertCircle, Loader2, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-black/90">
            {t("registry.title")}
          </h3>
          <p className="text-[12px] text-black/40">{t("registry.desc")}</p>
        </div>
        <Button onClick={openAddDialog} className="gap-1.5" size="sm">
          <Plus className="size-4" />
          {t("registry.add")}
        </Button>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-black/20 p-8 text-center">
          <p className="text-[13px] text-black/45">{t("registry.noSources")}</p>
          <p className="mt-1 text-[12px] text-black/35">
            {t("registry.noSourcesDesc")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((source, index) => (
            <div
              key={index}
              className="group flex items-center justify-between rounded-[10px] border border-black/10 bg-white px-4 py-3 transition-colors hover:border-black/20"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-black/[0.04] text-xl">
                  {getIcon(source)}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[14px] font-medium text-black/85">
                    {getDisplayName(source)}
                  </span>
                  <code className="truncate font-mono text-[11px] text-black/40">
                    {getDisplayUrl(source)}
                  </code>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => openEditDialog(index)}
                  className="rounded-[6px] p-1.5 text-black/35 hover:bg-black/[0.04] hover:text-black/85"
                >
                  <Edit2 className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(index)}
                  className="rounded-[6px] p-1.5 text-black/35 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md rounded-[20px] p-0 shadow-[0_16px_48px_-12px_rgba(30,20,50,0.18)]">
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
                <label className="mb-1.5 block text-[12px] font-medium text-black/55">
                  {t("registry.displayName")}
                </label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("registry.namePlaceholder")}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-black/55">
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
                <label className="mb-1.5 block text-[12px] font-medium text-black/55">
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
                <label className="mb-1.5 block text-[12px] font-medium text-black/55">
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
            </div>

            {testResult.status !== "idle" && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-[8px] px-3 py-2 text-[13px]",
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
