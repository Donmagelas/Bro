import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  dataRoot,
  prepareRoot,
  privateWrite,
} from "../../packages/platform/paths";
import { createHost } from "./server";

const root = dataRoot();
prepareRoot(root);
const lock = join(root, "host.lock");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) {
    console.error("bro 后台已经运行");
    process.exit(1);
  }
  unlinkSync(lock);
}
const fd = openSync(lock, "wx", 0o600);
writeFileSync(fd, String(process.pid));
closeSync(fd);
const token = randomBytes(32).toString("hex");
const host = createHost(root, token, {
  port: process.env.BRO_PORT ? Number(process.env.BRO_PORT) : undefined,
});
privateWrite(
  join(root, "host.json"),
  JSON.stringify({
    pid: process.pid,
    port: host.server.port,
    token,
    version: "0.1.0",
  }),
);
console.log(`bro host listening on 127.0.0.1:${host.server.port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await host.close();
  for (const file of ["host.json", "host.lock"])
    try {
      unlinkSync(join(root, file));
    } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
