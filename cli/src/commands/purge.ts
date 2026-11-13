// Emptying a bucket for `cms destroy --purge-objects`: count what is there for the
// plan, then delete it in batches of up to 1000 keys with a running count on one
// line. Listing always starts from the beginning again, because what was listed
// before has just been deleted.

import type { AccountApi } from "../cloudflare/port.js";
import type { Ctx } from "../frame/context.js";

export const PAGE = 1000;
/** Counting stops here and the plan says "at least": a full count of a big bucket is slow. */
export const COUNT_LIMIT = 10_000;

export interface ObjectCount {
  count: number;
  /** true when counting stopped at COUNT_LIMIT. */
  atLeast: boolean;
}

export async function countObjects(api: AccountApi, bucket: string): Promise<ObjectCount> {
  let count = 0;
  let after: string | undefined;
  while (count < COUNT_LIMIT) {
    const keys = await api.r2ListKeys(bucket, PAGE, after);
    count += keys.length;
    if (keys.length < PAGE) return { count, atLeast: false };
    after = keys[keys.length - 1];
  }
  return { count, atLeast: true };
}

export function describeCount(c: ObjectCount): string {
  return `${c.atLeast ? "at least " : ""}${c.count} ${c.count === 1 ? "object" : "objects"}`;
}

/** Delete every object; returns how many. Stops if a batch did not go away (no progress). */
export async function purgeBucket(ctx: Ctx, api: AccountApi, bucket: string): Promise<number> {
  let deleted = 0;
  let previousFirst: string | undefined;
  for (;;) {
    const keys = await api.r2ListKeys(bucket, PAGE);
    if (keys.length === 0) break;
    if (keys[0] === previousFirst) throw new Error(`objects in ${bucket} were not deleted (${keys[0]} is still there)`);
    previousFirst = keys[0];
    await api.r2DeleteKeys(bucket, keys);
    deleted += keys.length;
    if (ctx.animate) ctx.io.err(`\r   Deleting objects in ${bucket}: ${deleted}`);
  }
  if (ctx.animate) ctx.io.err("\r\u001b[2K");
  return deleted;
}
