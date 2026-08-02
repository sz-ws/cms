// `sz-ws-cms secrets` —— 確保三把受管金鑰在**已部署的** Worker 上存在。
//
// 為什麼要獨立成一個指令(而不是留在 setup 裡):
//   第一次跑 setup 時帳號上還沒有這個 Worker,`wrangler secret put` 沒有掛載對象,
//   必定失敗。舊流程於是把三把金鑰延後,並叫使用者「deploy 完再跑一次 setup」——
//   那個往返很反直覺,而且 setup 的其他步驟(建 D1/R2、改設定檔)第二次跑完全是白工。
//   拆出來之後,`pnpm run deploy` 的 postdeploy hook 直接呼叫這一支就補完了。
//
// 這個模組同時是三把金鑰的**單一定義來源**:setup.ts 從這裡 import 並 re-export,
// 兩邊不會各留一份清單而漂移。
//
// 絕不覆寫既有的值。SECRETS_KEY / AUTH_PEPPER 換掉都是不可逆的災難(見 MANAGED_SECRETS),
// 而 SETUP_TOKEN 換掉會讓一個還沒有管理員的站台把自己鎖在外面。

import { randomBytes } from "node:crypto";
import { EXIT } from "./exit.js";
import { displayWidth, padVisual, type Reporter } from "./ui.js";
import type { WranglerClient } from "./wrangler.js";

export const SECRETS_KEY = "SECRETS_KEY";
export const AUTH_PEPPER = "AUTH_PEPPER";
export const SETUP_TOKEN = "SETUP_TOKEN";

export interface ManagedSecret {
  readonly name: string;
  /** 這把金鑰在做什麼 —— 問使用者要不要產生時要講得出理由。 */
  readonly why: string;
  /** 已存在時印的那一行,講清楚為什麼我們不覆寫。 */
  readonly neverRotate: string;
  /** true = 新產生時把值印出來給人看。只有 SETUP_TOKEN 是 true。 */
  readonly reveal?: boolean;
}

/**
 * setup / secrets 會產生的 worker secret。前兩把都是**產生後就不能換**的:
 *
 *   SECRETS_KEY  換掉 → 所有已加密的設定同時變亂碼(信封沒有 key id)。
 *   AUTH_PEPPER  它會被 HMAC 進每一次密碼雜湊,而雜湊字串裡記著「當初有沒有
 *                pepper」。設了之後再拔掉,所有既存密碼都算不出來 = 全站鎖死。
 *
 * AUTH_PEPPER 一定要在**建立第一個管理員之前**就存在,否則第一批密碼會以
 * 無 pepper 的形式落地。核心對這種情況是容忍的(照雜湊裡的旗標驗證,不會鎖死),
 * 但那些密碼在重設之前一直享受不到 pepper 的保護 —— 而 pepper 正是 Workers
 * 只能跑 100k iteration 這件事最需要的補償。
 */
export const MANAGED_SECRETS: readonly ManagedSecret[] = [
  {
    name: SECRETS_KEY,
    why: "encrypts every `secret: true` setting (registry tokens, Resend key, OIDC secret, payment keys)",
    neverRotate:
      "Not overwriting — rotating the key invalidates every stored encrypted setting, with no gradual migration path.",
  },
  {
    name: AUTH_PEPPER,
    why: "HMACs the password before hashing; without it an offline attack on a leaked database cannot even start",
    neverRotate:
      "Not overwriting — rotating it makes every existing password uncomputable, locking everyone out.",
  },
  {
    name: SETUP_TOKEN,
    why: "bootstrap credential for /setup; stops whoever finds the URL first from claiming the admin account",
    neverRotate: "Not overwriting — the site may have no admin yet; rotating it locks you out too.",
    // 唯一會被印出來的一把:它的用途就是給人貼進 /setup 的表單,而且建完
    // 第一個管理員之後就完全失效(那個端點從此一律回 403)。另外兩把印出來
    // 只有壞處 —— 它們的值永遠不需要被人眼看到。
    reveal: true,
  },
];

/** 32 byte base64 —— 與 DEPLOY.md 的 `openssl rand -base64 32` 等價。 */
export function defaultSecretGenerator(): string {
  return randomBytes(32).toString("base64");
}

/** 自動補設失敗時的備援。**不是主要路徑** —— 主要路徑是 `pnpm run deploy`。 */
export function manualSecretCommands(
  names: readonly string[] = MANAGED_SECRETS.map((s) => s.name),
): string[] {
  return names.map(
    (name) => `openssl rand -base64 32 | pnpm exec wrangler secret put ${name}`,
  );
}

/**
 * 三段警告的文字**一個字都不能刪** —— 每一段講的都是「做錯就整站鎖死」的事。
 * 集中在這裡是為了 setup 與 secrets 兩支指令印出來的是同一份,不會其中一邊過期。
 */
export const FIRST_ADMIN_TITLE = "⚠ before you create the first admin";
export const NO_ROTATION_TITLE = "⚠ these keys can never be rotated";

export const FIRST_ADMIN_WARNINGS: readonly string[] = [
  `⚠ ${AUTH_PEPPER} must be set **before** opening /setup to create first admin,`,
  "  otherwise first batch of passwords will lack pepper protection (can still login, but less secure).",
  `⚠ if ${SETUP_TOKEN} is not set, /setup always returns 503 — this is intentional:`,
  "  without it, first person to find the URL becomes admin.",
];

export const NO_ROTATION_WARNINGS: readonly string[] = [
  "⚠ don't reuse dev keys from .dev.vars. both cannot be rotated once set:",
  `  rotate ${SECRETS_KEY} → all encrypted settings become gibberish (envelope has no key id).`,
  `  rotate ${AUTH_PEPPER} → all existing passwords become uncomputable, site completely locked.`,
];

export interface SecretsOptions {
  client: WranglerClient;
  reporter: Reporter;
  /** true → 只報告現況,一把都不產生、不送出。 */
  dryRun: boolean;
  /** 可注入,測試才能斷言「送進 secret put 的就是這個值」。 */
  generateSecret?: () => string;
}

/**
 * 對齊用:名稱欄以**終端欄寬**取最大值(CJK 一個字兩欄,見 ui.ts:displayWidth)。
 * 這裡的名稱雖然都是 ASCII,但 why 的文字未來可能被翻譯,用 .length 對齊會歪。
 */
function alignedRows(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => displayWidth(left)));
  return rows.map(([left, right]) => `${padVisual(left, width)}  ${right}`);
}

export async function runSecrets(o: SecretsOptions): Promise<number> {
  const { reporter: r } = o;
  const generateSecret = o.generateSecret ?? defaultSecretGenerator;

  r.intro(
    "sz-ws-cms secrets",
    o.dryRun
      ? "rehearsal mode: report which managed secrets are missing, generate nothing."
      : "ensure the three managed secrets exist on the deployed Worker.",
  );

  const existing = await r.task("checking the Worker secret list", () =>
    o.client.listSecrets(),
  );

  if (existing === null) {
    // 查不到 ≠ 沒設定。最常見的原因是 Worker 還沒 deploy 過,再來是未登入 / 網路。
    // 這裡不能猜「沒設定」就硬寫(會在錯的 Worker 上建),也不能說「都好了」。
    r.step(
      "fail",
      "could not read the Worker secret list",
      "usual causes: the Worker has never been deployed, `wrangler` is not logged in, or the network is down.",
    );
    r.note("set them manually — each value is generated once and never rotated", [
      ...manualSecretCommands(),
      "",
      `after setting ${SETUP_TOKEN} you need its value; wrangler cannot read a secret back,`,
      "so paste the generated value into /setup yourself, or run this command again once the",
      "Worker exists and let it generate the missing ones for you.",
    ]);
    r.note(FIRST_ADMIN_TITLE, [...FIRST_ADMIN_WARNINGS]);
    r.note(NO_ROTATION_TITLE, [...NO_ROTATION_WARNINGS]);
    r.outro([`✗ managed secrets not verified.`]);
    return EXIT.SETUP_FAILED;
  }

  const present = MANAGED_SECRETS.filter((s) => existing.includes(s.name));
  const missing = MANAGED_SECRETS.filter((s) => !existing.includes(s.name));

  for (const spec of present) {
    r.step("ok", `${spec.name} already set`, spec.neverRotate);
  }

  if (missing.length === 0) {
    r.outro(["✓ all three managed secrets are already set on the Worker."]);
    return EXIT.OK;
  }

  if (o.dryRun) {
    r.note(
      `would generate ${missing.length} missing secret${missing.length === 1 ? "" : "s"}`,
      alignedRows(missing.map((s) => [s.name, s.why] as const)),
    );
    r.outro(["rehearsal complete, nothing was generated. remove --dry-run to actually set them."]);
    return EXIT.OK;
  }

  const failures: string[] = [];
  // 只有「這次新建」的 SETUP_TOKEN 值進得了這裡。已存在的那把我們根本讀不到值。
  let revealed: string | null = null;

  for (const spec of missing) {
    // 值走 stdin 進 wrangler,不進 argv、不印到畫面 —— argv 會被 ps 看到,也會留在 history。
    const value = generateSecret();
    const outcome = await r.task(`setting ${spec.name}`, () =>
      o.client.putSecret(spec.name, value),
    );
    if (outcome.status === "failed") {
      r.step("fail", `failed to set ${spec.name}`, outcome.detail);
      failures.push(spec.name);
      continue;
    }
    r.step(
      "ok",
      `${spec.name} generated and set`,
      spec.reveal === true
        ? "value is printed below — this is the only time it can be shown."
        : "value exists only on Cloudflare, no local copy.",
    );
    if (spec.reveal === true) revealed = value;
  }

  if (revealed !== null) {
    // 這一把非印不可:CLI 不會替使用者開瀏覽器填表,而 wrangler 事後也讀不回
    // secret 的值。不印 = 使用者永遠建不出第一個管理員,只能自己覆寫一把。
    r.note(`${SETUP_TOKEN} — copy it now, it cannot be shown again`, [
      revealed,
      "",
      "paste it into the /setup form when creating the first admin; it stops working after that.",
    ]);
  }

  if (failures.length > 0) {
    r.note("set the failed ones manually", manualSecretCommands(failures));
    r.note(FIRST_ADMIN_TITLE, [...FIRST_ADMIN_WARNINGS]);
    r.outro([`✗ ${failures.length} managed secrets could not be set: ${failures.join(", ")}`]);
    return EXIT.SETUP_FAILED;
  }

  r.note(FIRST_ADMIN_TITLE, [...FIRST_ADMIN_WARNINGS]);
  r.note(NO_ROTATION_TITLE, [...NO_ROTATION_WARNINGS]);
  r.outro([
    `✓ ${missing.length} managed secret${missing.length === 1 ? "" : "s"} generated and set.`,
  ]);
  return EXIT.OK;
}
