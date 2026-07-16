// Minimal ambient types for the subset of Node 26's built-in `node:sqlite`
// module used by the migration scripts. The installed @types/node predates
// node:sqlite, so we declare only what we call here (no `any`).
declare module "node:sqlite" {
  interface StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  }
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
