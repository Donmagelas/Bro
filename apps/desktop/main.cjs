const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  Notification,
} = require("electron");
const { join, resolve, dirname, delimiter } = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
app.setName("Bro");
let window, info, streamController, connecting;
const root =
  process.env.BRO_DATA_DIR ||
  (process.platform === "darwin"
    ? join(app.getPath("appData"), "bro")
    : join(process.env.LOCALAPPDATA || app.getPath("appData"), "bro"));
app.setPath("userData", join(root, "desktop"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
function connectHost() {
  return (connecting ||= startOrFindHost().finally(() => {
    connecting = undefined;
  }));
}
async function startOrFindHost() {
  const file = join(root, "host.json");
  const discover = async () => {
    try {
      const candidate = JSON.parse(fs.readFileSync(file, "utf8"));
      const r = await fetch(`http://127.0.0.1:${candidate.port}/health`, {
        headers: { Authorization: `Bearer ${candidate.token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        info = candidate;
        return true;
      }
    } catch {}
    return false;
  };
  if (await discover()) return;
  fs.mkdirSync(join(root, "logs"), { recursive: true });
  const packagedBun = join(
    process.resourcesPath,
    "runtime",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  const bundled = fs.existsSync(packagedBun);
  const base = bundled
    ? join(process.resourcesPath, "app")
    : resolve(__dirname, "../..");
  const bun = process.env.BRO_BUN_PATH || (bundled ? packagedBun : "bun");
  const log = fs.openSync(join(root, "logs", "host.log"), "a");
  const child = spawn(bun, [join(base, "apps/host/main.ts")], {
    detached: true,
    cwd: base,
    env: {
      ...process.env,
      BRO_DATA_DIR: root,
      PATH: `${dirname(bun)}${delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let launchError;
  child.on("error", (e) => {
    launchError = e;
  });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 120; i++) {
    if (launchError) throw launchError;
    if (await discover()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`后台启动超时，请查看 ${join(root, "logs", "host.log")}`);
}
async function request(path, method = "GET", body) {
  if (!/^\/[a-z][a-z0-9/_-]*(?:\?.*)?$/.test(path))
    throw new Error("无效接口路径");
  await connectHost();
  const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${info.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function subscribe() {
  streamController?.abort();
  streamController = new AbortController();
  const signal = streamController.signal;
  while (!signal.aborted) {
    try {
      await connectHost();
      const r = await fetch(`http://127.0.0.1:${info.port}/events`, {
        headers: { Authorization: `Bearer ${info.token}` },
        signal,
      });
      if (!r.ok || !r.body) throw new Error("状态连接失败");
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of r.body) {
        text += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          if (block.startsWith("data: ")) {
            const event = JSON.parse(block.slice(6));
            if (event.type === "desktop_notice" && Notification.isSupported())
              new Notification({
                title: "Bro · 前台操作",
                body: event.message,
              }).show();
            window?.webContents.send("bro:event", event);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted)
        window?.webContents.send("bro:event", {
          type: "disconnected",
          error: String(error),
        });
    }
    if (!signal.aborted) await new Promise((r) => setTimeout(r, 1500));
  }
}
ipcMain.handle("bro:request", (_event, path, method, body) =>
  request(path, method, body),
);
ipcMain.handle("bro:directory", async () => {
  const r = await dialog.showOpenDialog(window, {
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("bro:attachments", async () => {
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  await connectHost();
  const attachments = [];
  for (const path of result.filePaths) {
    const data = fs.readFileSync(path);
    if (data.length > 25 * 1024 * 1024)
      throw new Error("单个附件不能超过 25 MB");
    const ext = path.split(".").pop().toLowerCase();
    const types = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    };
    const form = new FormData();
    form.append(
      "file",
      new Blob([data], { type: types[ext] || "application/octet-stream" }),
      require("node:path").basename(path),
    );
    const r = await fetch(`http://127.0.0.1:${info.port}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}` },
      body: form,
    });
    if (!r.ok) throw new Error((await r.json()).error);
    attachments.push(await r.json());
  }
  return attachments;
});
ipcMain.handle("bro:stopHost", async () => {
  await connectHost();
  streamController?.abort();
  process.kill(info.pid, "SIGTERM");
  app.quit();
});
ipcMain.handle("bro:loginItem", (_event, enabled) => {
  if (typeof enabled === "boolean")
    app.setLoginItemSettings({ openAtLogin: enabled, args: ["--background"] });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle("bro:open", async (_event, target) => {
  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target);
    return;
  }
  if (typeof target !== "string" || !require("node:path").isAbsolute(target))
    throw new Error("无效文件路径");
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
});
app
  .whenReady()
  .then(async () => {
    if (process.argv.includes("--background")) {
      await connectHost();
      app.quit();
      return;
    }
    app.setAboutPanelOptions({
      applicationName: "Bro",
      iconPath: join(__dirname, "assets/icon.png"),
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Bro",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    window = new BrowserWindow({
      width: 1240,
      height: 840,
      minWidth: 800,
      minHeight: 600,
      title: "Bro",
      backgroundColor: "#f4e9d7",
      icon: join(
        __dirname,
        "assets",
        process.platform === "win32" ? "icon.ico" : "icon.png",
      ),
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      trafficLightPosition: { x: 18, y: 19 },
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    if (process.env.BRO_RENDERER_URL)
      await window.loadURL(process.env.BRO_RENDERER_URL);
    else
      await window.loadFile(join(__dirname, "../../dist/renderer/index.html"));
    void subscribe();
  })
  .catch((error) => {
    dialog.showErrorBox("Bro 启动失败", String(error));
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => streamController?.abort());
