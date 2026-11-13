// Reading what cf prints.
//
// stdout: pretty-printed JSON, sometimes followed by a line of advice for agents
// (observed on `cf auth whoami` when signed out), so the first complete JSON value
// is taken and the rest ignored.
// stderr on failure: a box such as
//   ┌ APIError
//   │ [10007] This Worker does not exist on your account.
//   │ 404 Not Found · HTTP /accounts/<id>/workers/...
//   └
// The HTTP line carries the account id, so it never goes into a message.

import { CloudflareError, type CloudflareFailure } from "./port.js";

/** The first complete JSON object or array in the text, or undefined. */
export function firstJsonValue(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const AUTH_CODES = new Set([9106, 9109, 10000, 10001]);
// 7403 ("not authorized to access this service") shows up intermittently on
// healthy accounts during deploys; CI scripts retry it, so the policy does too.
const TRANSIENT_CODES = new Set([7403, 10013]);
const NETWORK_RE = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network/i;

export interface ParsedFailure {
  apiCode?: number;
  status?: number;
  message: string;
}

export function parseFailure(stderr: string, exitCode: number): ParsedFailure {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s┌│└]+/, "").trim())
    .filter((l) => l !== "");
  const coded = lines.map((l) => /^\[(\d+)\]\s*(.+)$/.exec(l)).find(Boolean);
  const http = lines.map((l) => /^(\d{3})\s[^·]*·\s*HTTP\b/.exec(l)).find(Boolean);
  const plain = lines.filter((l) => !/·\s*HTTP\b/.test(l) && !/^(APIError|Error)$/.test(l) && !/^For more information/.test(l));
  return {
    apiCode: coded ? Number(coded[1]) : undefined,
    status: http ? Number(http[1]) : undefined,
    message: coded?.[2] ?? plain[0] ?? `cf exited with code ${exitCode}`,
  };
}

export function classify(f: ParsedFailure): CloudflareFailure {
  if (/not logged in/i.test(f.message)) return "AUTH_REQUIRED";
  if (f.apiCode === 10007 || f.status === 404) return "NOT_FOUND";
  if (f.status === 401 || (f.apiCode !== undefined && AUTH_CODES.has(f.apiCode))) return "AUTH_INVALID";
  if (f.apiCode !== undefined && TRANSIENT_CODES.has(f.apiCode)) return "TRANSIENT";
  if (f.status === 403) return "PERMISSION_DENIED";
  if (f.status === 429 || (f.status !== undefined && f.status >= 500)) return "TRANSIENT";
  if (f.status === undefined && NETWORK_RE.test(f.message)) return "TRANSIENT";
  return "FAILED";
}

export function failureFrom(stderr: string, exitCode: number): CloudflareError {
  const parsed = parseFailure(stderr, exitCode);
  const prefix = parsed.apiCode !== undefined ? `[${parsed.apiCode}] ` : "";
  return new CloudflareError(classify(parsed), `${prefix}${parsed.message}`, parsed.apiCode, parsed.status);
}
