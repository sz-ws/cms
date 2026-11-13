// `cms login`: sign in to Cloudflare through cf, or report where auth comes from
// when already signed in. No site directory needed.

import type { Identity } from "../cloudflare/port.js";
import type { Ctx, Outcome } from "../frame/context.js";
import { CliError } from "../frame/errors.js";
import { ensureCf, runLogin } from "./connect.js";
import { plural } from "./format.js";

function result(identity: Identity, already: boolean, cfVersion: string): Outcome {
  const source = identity.source ?? { kind: "other", label: "cf credentials" };
  const data = {
    signedIn: true,
    alreadySignedIn: already,
    source,
    email: identity.email ?? null,
    accounts: identity.accounts,
    cf: { version: cfVersion },
  };
  const who = identity.email ? ` as ${identity.email}` : "";
  const text = [
    already ? `Already signed in${who} (${source.label}${source.profile ? `, profile ${source.profile}` : ""}).` : `Signed in${who}.`,
    `${plural(identity.accounts.length, "account")} visible${identity.accounts.length > 0 ? `: ${identity.accounts.map((a) => a.name).join(", ")}` : ""}.`,
    ...(source.kind === "api-token" ? ["CLOUDFLARE_API_TOKEN takes precedence over a browser login; unset it to use cf's login."] : []),
  ].join("\n");
  return { data, text };
}

export async function runLoginCommand(ctx: Ctx): Promise<Outcome> {
  const port = ctx.cloudflare();
  const cf = await ensureCf(ctx, port);
  const identity = await port.whoami();
  if (identity.authenticated) return result(identity, true, cf.version);
  if (!ctx.interactive) {
    throw new CliError({
      code: "AUTH_REQUIRED",
      message: "Not signed in to Cloudflare, and signing in needs a terminal with a browser.",
      hint: "Run `cms login` in a terminal, or set CLOUDFLARE_API_TOKEN to an API token (for CI and agents).",
      next: ["cms login"],
    });
  }
  return result(await runLogin(ctx, port), false, cf.version);
}
