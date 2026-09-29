import { join } from "node:path";
const root = join(import.meta.dir, "..");
const vite = Bun.spawn(
  [process.execPath, join(root, "node_modules/vite/bin/vite.js")],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch("http://127.0.0.1:5173")).ok) break;
  } catch {}
  await Bun.sleep(100);
}
const electron = Bun.spawn(
  ["node", join(root, "node_modules/electron/cli.js"), root],
  {
    cwd: root,
    env: {
      ...process.env,
      BRO_BUN_PATH: process.execPath,
      BRO_RENDERER_URL: "http://127.0.0.1:5173",
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
const stop = () => {
  electron.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await electron.exited;
vite.kill();
