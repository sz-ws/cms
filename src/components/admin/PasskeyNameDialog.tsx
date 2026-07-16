"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";

interface PasskeyNameDialogProps {
  open: boolean;
  onSubmit: (name: string | undefined) => void;
}

// WebAuthn ceremony 完成後的命名步驟,取代舊版 window.prompt。credential 已經在
// 瀏覽器端建立(使用者剛做完 Face ID / Touch ID),所以命名不能真的整個取消——
// 任何關閉方式都要送出,差別只在名稱怎麼決定:
//   - Enter / 按鈕:送目前輸入值(空白 → undefined,server 由 User-Agent 推斷預設名)
//   - Esc / 點背景:不理會目前輸入到一半的字,直接用預設名(對齊舊版「取消
//     window.prompt = 用預設名」的行為)
// showCloseButton 關掉是故意的:右上角 X 若還在,語意會跟「Esc = 用預設名」衝突
// (看起來像純取消)。
//
// 每次呼叫端開新一輪命名都會換一個 key(見 PasskeysManager 的 namingSession),
// 讓這個元件整個 remount 來清空輸入框 —— 用 key 而非 effect+setState,
// 避免 react-hooks/set-state-in-effect 那條規則。
export function PasskeyNameDialog({ open, onSubmit }: PasskeyNameDialogProps) {
  const t = useT();
  const [name, setName] = useState("");

  function submitWithName() {
    const trimmed = name.trim();
    onSubmit(trimmed.length > 0 ? trimmed : undefined);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onSubmit(undefined);
      }}
    >
      <DialogContent
        className="max-w-sm rounded-[20px] p-0 shadow-[0_16px_48px_-12px_rgba(30,20,50,0.18)]"
        showCloseButton={false}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitWithName();
          }}
          className="flex flex-col gap-4 p-5"
        >
          <DialogHeader>
            <DialogTitle>{t("passkeyName.title")}</DialogTitle>
            <DialogDescription>{t("passkeyName.desc")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("passkeyName.placeholder")}
          />
          <Button type="submit" className="gap-1.5">
            {t("passkeyName.addPasskey")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
