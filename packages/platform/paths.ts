import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync, writeFileSync, renameSync } from "node:fs";
export function dataRoot(): string {
  if (process.env.BRO_DATA_DIR) return resolve(process.env.BRO_DATA_DIR);
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "bro");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || homedir(), "bro");
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "bro",
  );
}
export function prepareRoot(root: string) {
  for (const dir of [
    "",
    "agent",
    "sessions",
    "attachments",
    "logs",
    "workspaces",
  ]) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") chmodSync(root, 0o700);
}
export function privateWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
