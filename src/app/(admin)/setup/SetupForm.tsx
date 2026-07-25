"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui/legacy";
import { useT } from "@/lib/i18n/I18nProvider";

export function SetupForm() {
  const t = useT();
  const router = useRouter();
  const [siteTitle, setSiteTitle] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteTitle, name, email, password, setupToken }),
      });
      if (res.ok) {
        router.push("/admin");
        return;
      }
      // 每一種拒絕都有不同的下一步,混成同一句「請檢查表單」等於叫人瞎猜。
      if (res.status === 403) {
        setError(t("setup.alreadyCompleted"));
      } else if (res.status === 401) {
        setError(t("setup.tokenError"));
      } else if (res.status === 503) {
        setError(t("setup.tokenMissing"));
      } else if (res.status === 429) {
        setError(t("setup.rateLimited"));
      } else {
        setError(t("setup.formError"));
      }
    } catch (submissionError) {
      console.error("[setup] admin creation request failed", submissionError);
      setError(t("setup.networkError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-foreground">
            {t("setup.siteTitle")}
          </label>
          <Input
            value={siteTitle}
            onChange={(e) => setSiteTitle(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-foreground">
            {t("setup.adminName")}
          </label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-foreground">
            {t("setup.email")}
          </label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-foreground">
            {t("setup.password")}
          </label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-foreground">
            {t("setup.setupToken")}
          </label>
          <Input
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            {t("setup.setupTokenHint")}
          </p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? t("setup.creating") : t("setup.createAdmin")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
