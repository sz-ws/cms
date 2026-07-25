"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui/legacy";
import { PasswordWorkFactorWizard } from "@/components/admin/PasswordWorkFactorWizard";
import { useT } from "@/lib/i18n/I18nProvider";

export function SetupForm({
  initialPasswordIterations,
}: {
  initialPasswordIterations: number | null;
}) {
  const t = useT();
  const router = useRouter();
  const [siteTitle, setSiteTitle] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passwordCalibrated, setPasswordCalibrated] = useState(
    initialPasswordIterations !== null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!passwordCalibrated) {
      setError(t("setup.passwordCalibrationRequired"));
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteTitle, name, email, password }),
      });
      if (res.ok) {
        router.push("/admin");
        return;
      }
      if (res.status === 403) {
        setError(t("setup.alreadyCompleted"));
      } else if (res.status === 409) {
        setPasswordCalibrated(false);
        setError(t("setup.passwordCalibrationRequired"));
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
        <PasswordWorkFactorWizard
          initialIterations={initialPasswordIterations}
          onCalibrated={() => setPasswordCalibrated(true)}
        />
        <div className="h-px bg-black/[0.06]" />
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
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending || !passwordCalibrated}>
            {pending ? t("setup.creating") : t("setup.createAdmin")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
