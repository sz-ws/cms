import { mkdir, readFile, writeFile, lstat, chmod, rm, rename, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** 只保存首次 setup token，不保存密碼、AUTH_PEPPER 或 SECRETS_KEY。 */
export function bootstrapState(cwd: string, workerName: string, databaseId: string) {
  const dir = path.join(cwd, ".cms");
  const file = path.join(dir, "bootstrap.json");
  const identity = `${workerName}:${databaseId}`;
  const noSymlink = async (target: string) => {
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error("Bootstrap recovery path must not be a symlink.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  return {
    async read(): Promise<string> {
      await noSymlink(dir);
      await noSymlink(file);
      try {
        const value = JSON.parse(await readFile(file, "utf8")) as { identity?: string; token?: string };
        return value.identity === identity && typeof value.token === "string" ? value.token : "";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw new Error("Could not read local bootstrap recovery state.");
      }
    },
    async save(token: string): Promise<void> {
      const ignore = path.join(cwd, ".gitignore");
      await noSymlink(ignore);
      let text = "";
      try { text = await readFile(ignore, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // 只比最後一行的話,任何寫在 .gitignore 中間的 /.cms/ 都會被漏掉,
      // 於是每一次重跑都再追加一行。整份掃過去才是冪等的。
      if (!text.split(/\r?\n/).some((line) => line.trim() === "/.cms/")) {
        await writeFile(ignore, `${text}${text.endsWith("\n") || !text ? "" : "\n"}/.cms/\n`, "utf8");
      }
      await noSymlink(dir);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await noSymlink(file);
      const temporary = path.join(dir, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ identity, token }), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async clear(): Promise<void> {
      await noSymlink(dir);
      await noSymlink(file);
      await rm(file, { force: true });
      // 只留一個空目錄會讓人以為部署還有殘留狀態。裡面還有別的東西就讓 rmdir 失敗,
      // 不遞迴刪 —— 那是使用者的檔案,不是我們的。
      await rmdir(dir).catch(() => undefined);
    },
  };
}
