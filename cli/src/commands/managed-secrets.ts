// The three managed Worker secrets (SECRETS_KEY, AUTH_PEPPER, SETUP_TOKEN), with
// the rules from 0.x kept as they were:
//   - only missing keys are generated; an existing key is never rotated
//   - a value never appears on a command line, in a log or in JSON
//   - "cannot read the list" is not "not set": nothing is written then
//   - a new SETUP_TOKEN is handed to the caller before it is sent, so a run that
//     dies after the write still has the only copy

import type { AccountApi } from "../cloudflare/port.js";
import { CloudflareError } from "../cloudflare/port.js";
import { CliError } from "../frame/errors.js";
import { fromCloudflare, VERSION_NOT_LIVE_CODE } from "../frame/output.js";
import { MANAGED_SECRETS, defaultSecretGenerator } from "../secrets.js";

export interface ManagedSecretsResult {
  present: string[];
  /** Missing before this run; created unless dryRun. */
  missing: string[];
  created: string[];
}

export interface ManagedSecretsOptions {
  dryRun: boolean;
  generate?: () => string;
  /** Receives a newly generated SETUP_TOKEN before it is set on the Worker. */
  onSetupToken?: (value: string) => Promise<void>;
  /** Command to name in `next` when something fails. */
  again: string;
}

async function readNames(api: AccountApi, worker: string, again: string): Promise<string[]> {
  const names = await api.secretNames(worker);
  if (names === null) {
    throw new CliError({
      code: "SECRETS_UNREADABLE",
      message: `Could not read the secret names of the Worker ${worker}; nothing was written.`,
      hint: "Cannot read is not the same as not set. The Worker may not be deployed yet.",
      next: [again],
    });
  }
  return names;
}

export async function ensureManagedSecrets(api: AccountApi, worker: string, o: ManagedSecretsOptions): Promise<ManagedSecretsResult> {
  const names = await readNames(api, worker, o.again);
  const present = MANAGED_SECRETS.filter((m) => names.includes(m.name)).map((m) => m.name);
  const missing = MANAGED_SECRETS.filter((m) => !names.includes(m.name));
  if (o.dryRun || missing.length === 0) return { present, missing: missing.map((m) => m.name), created: [] };
  const generate = o.generate ?? defaultSecretGenerator;
  const created: string[] = [];
  for (const spec of missing) {
    const value = generate();
    if (spec.reveal && o.onSetupToken) await o.onSetupToken(value);
    try {
      await api.putSecret(worker, spec.name, value);
    } catch (e) {
      if (e instanceof CloudflareError && e.apiCode === VERSION_NOT_LIVE_CODE) throw fromCloudflare(e, o.again);
      throw new CliError({
        code: "SECRETS_FAILED",
        message: `Could not set ${spec.name}: ${e instanceof Error ? e.message : String(e)}`,
        hint: created.length > 0 ? `${created.join(", ")} were set. Existing keys are never overwritten, so running again is safe.` : "Running again is safe.",
        next: [o.again],
      });
    }
    created.push(spec.name);
  }
  const after = await readNames(api, worker, o.again);
  const stillMissing = MANAGED_SECRETS.filter((m) => !after.includes(m.name)).map((m) => m.name);
  if (stillMissing.length > 0) {
    throw new CliError({ code: "SECRETS_FAILED", message: `Set, but not listed on the Worker: ${stillMissing.join(", ")}.`, next: [o.again] });
  }
  return { present, missing: missing.map((m) => m.name), created };
}
