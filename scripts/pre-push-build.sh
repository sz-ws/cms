#!/usr/bin/env bash
# git pre-push hook:push 前跑 tsc + vitest + next build,任一失敗即擋 push。
# 用途:防範 #20 類「tsc/vitest 綠但 next build 掛」的問題潛伏(module-init 循環只有
#       next build 的 production eval 現形)。
#
# 啟用(從 repo root,假設 cms 在 repo root 下):
#   chmod +x cms/scripts/pre-push-build.sh
#   ln -sf ../../cms/scripts/pre-push-build.sh .git/hooks/pre-push
# 或用 core.hooksPath(版控所有 hook):git config core.hooksPath cms/scripts/hooks
#
# 為什麼是 pre-push 而不是 Stop hook:build 數分鐘,Stop hook 每次 session 收尾都跑
# → 尾巴痛苦 → 最後被關掉。push 頻率低於 session end,可接受。
set -euo pipefail

# git 跑 hook 時 cwd = repo root;允許 CMS_DIR 覆寫。
CMS_DIR="${CMS_DIR:-cms}"
cd "$CMS_DIR"

echo "[pre-push] (1/3) tsc --noEmit"
pnpm exec tsc --noEmit

echo "[pre-push] (2/3) vitest run"
pnpm exec vitest run

echo "[pre-push] (3/3) next build"
pnpm build

echo "[pre-push] 全綠,允許 push"
