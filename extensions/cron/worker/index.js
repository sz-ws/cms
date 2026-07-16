// Companion worker 範本(不隨 CMS 部署)—— 分鐘級準時排程的「錶」。
//
// Cloudflare 的 `scheduled` handler 依 wrangler.jsonc 的 cron 觸發;它對 CMS 的
// 統一 callback ingress 送一個帶 HMAC-SHA256 簽章的 POST。CMS 端的 cron:tick/cron
// provider 驗簽後催動到期任務掃描(runDueJobs)。CRON_SECRET 必須與 admin settings
// 的「Cron signing secret」同值(見 README)。

async function sign(body, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const worker = {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const body = JSON.stringify({ ts: Date.now() });
        const sig = await sign(body, env.CRON_SECRET);
        const res = await fetch(env.SITE_URL + "/api/callback/cron:tick/cron", {
          method: "POST",
          headers: { "x-signature": sig, "content-type": "application/json" },
          body,
        });
        if (!res.ok) console.error("[cron worker] tick failed", res.status);
      })(),
    );
  },
};

export default worker;
