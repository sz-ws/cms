import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { getDB } from "./cf";

export function db() {
  return drizzle(getDB(), { schema });
}
