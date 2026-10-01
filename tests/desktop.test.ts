import { expect, spyOn, test } from "bun:test";
import { Desktop } from "../apps/host/desktop";

function setup(overrides: any = {}, notice = (_: string) => {}) {
  const windows = [
    { id: "opaque-A", pid: 10, app: "Editor", focused: false },
    { id: "opaque-B", pid: 20, app: "Browser", focused: true },
  ];
  const calls: any[] = [];
  const desktop = new Desktop(
    "/unused",
    () => {},
    async () => ({
      capabilities: { backgroundWindowInput: true },
      async close() {},
      async listWindows() {
        return windows;
      },
      async typeText(target: string, text: string) {
        calls.push([target, text]);
      },
      async click(...args: any[]) {
        calls.push(args);
      },
      async axSetValue(...args: any[]) {
        calls.push(args);
      },
      async axSnapshot() {
        return { text: "Text [ref=e7]", nodeCount: 1 };
      },
      async axQuery() {
        return [{ ref: "e7", role: "text" }];
      },
      async axChildren() {
        return [{ ref: "e8", role: "text" }];
      },
      async capture(target: string) {
        calls.push(target);
        return { data: new Uint8Array([1, 2]), width: 1, height: 1, target };
      },
      ...overrides,
    }),
    notice,
  );
  desktop.state.enabled = true;
  desktop.inputEvent({ type: "ready" });
  return { desktop, windows, calls };
}
const type = (target = "opaque-A", text = "abcdefghijklmnopqrstuvwxyz") => ({
  method: "typeText",
  args: [target, text],
});
const capture = { method: "capture" };

test("invalid desktop arguments reject the whole batch before earlier writes or native initialization", async () => {
  const invalid = [
    { method: "axQuery", args: ["opaque-A", "Save"] },
    { method: "axQuery", args: ["opaque-A", { title: "Save", limti: 5 }] },
    { method: "axSnapshot", args: ["opaque-A", { maxDepth: -1 }] },
    { method: "click", args: ["opaque-A", "12", 30] },
    { method: "click", args: ["opaque-A", Infinity, 30] },
    { method: "click", args: ["opaque-A", 12, 30, { takeOver: true }] },
    { method: "typeText", args: ["opaque-A", { text: "hello" }] },
    { method: "keyChord", args: ["opaque-A", "Meta+S"] },
    { method: "listWindows", args: ["ignored"] },
    { method: "axFocus", args: ["e7", { takeover: true }] },
    { method: "capture", args: null },
    { method: "__proto__", args: [] },
    null,
  ];
  let initialized = false;
  const desktop = new Desktop(
    "/unused",
    () => {},
    async () => {
      initialized = true;
      throw new Error("native must never load");
    },
  );
  desktop.state.enabled = true;
  for (const op of invalid) {
    await expect(desktop.execute("one", [type(), op] as any)).rejects.toThrow(
      /参数无效|方法不支持/,
    );
    expect(initialized).toBe(false);
    expect(desktop.state.owner).toBeNull();
  }
});

test("typed queries and snapshot options reach the backend without losing filters", async () => {
  const received: any[] = [];
  const { desktop } = setup({
    async axQuery(...args: any[]) {
      received.push(args);
      return [{ ref: "e7", role: "button" }];
    },
    async axSnapshot(...args: any[]) {
      received.push(args);
      return { text: "Button [ref=e8]" };
    },
  });
  const query = { title: "Save", role: "button", limit: 3 };
  const options = { maxDepth: 20, maxNodes: 500 };
  await desktop.execute("one", [
    { method: "axQuery", args: ["opaque-A", query] },
    { method: "axSnapshot", args: ["opaque-A", options] },
  ]);
  expect(received).toEqual([
    ["opaque-A", query],
    ["opaque-A", options],
  ]);
});

test("dispatched clicks do not claim a UI effect or silently replay with foreground input", async () => {
  const { desktop, calls } = setup();
  const result = await desktop.execute("one", [
    { method: "click", args: ["opaque-A", 12, 30] },
    capture,
  ]);
  expect(calls).toEqual([["opaque-A", 12, 30], "desktop"]);
  expect(JSON.parse(result.content[0].text)).toEqual({
    method: "click",
    result: { status: "dispatched", effectVerified: false },
  });
  expect(result.details.completedOperations).toBe(2);
});

test("newly granted permissions distinguish a stale native backend from usable tools", async () => {
  const { desktop } = setup({
    capabilities: { capture: false, input: false, ax: false },
  });
  desktop.state.enabled = false;
  (desktop as any).monitor = {
    async permissions() {
      return { screen: true, accessibility: true, inputMonitoring: true };
    },
  };
  expect((await desktop.permissions()).restartRequired).toBe(
    process.platform === "darwin",
  );
  (desktop as any).nativeFactory = async () => ({
    capabilities: { capture: true, input: true, ax: true },
    close() {},
  });
  expect((await desktop.permissions()).restartRequired).toBe(false);
});

test("permission checks preserve disabled/paused state and reject prompting during desktop work", async () => {
  const { desktop } = setup();
  const requested: any[] = [];
  (desktop as any).monitor = {
    async permissions(key?: string) {
      requested.push(key);
      return { screen: true, accessibility: false, inputMonitoring: false };
    },
    async start() {},
    stop() {},
  };
  desktop.state.enabled = false;
  desktop.pause();
  expect(
    (await desktop.permissions("accessibility")).permissions.accessibility,
  ).toBe(false);
  expect(requested).toEqual(["accessibility"]);
  expect(desktop.state.enabled).toBe(false);
  expect(desktop.state.paused).toBe(true);
  desktop.state.owner = "running-task";
  await expect(desktop.permissions("screen")).rejects.toThrow("当前桌面操作");
  expect(requested).toHaveLength(1);
});

test("background writing continues while human types/clicks another app or moves over target", async () => {
  const chunks: string[] = [];
  const { desktop } = setup({
    async typeText(_target: string, text: string) {
      chunks.push(text);
      desktop.inputEvent({ type: "human", kind: "key", pid: 20 });
      desktop.inputEvent({ type: "human", kind: "pointer", pid: 20 });
      desktop.inputEvent({ type: "human", kind: "move", pid: 10 });
    },
  });
  await desktop.execute("one", [type()]);
  expect(chunks.join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  expect(desktop.state.paused).toBe(false);
  expect(desktop.state.mode).toBe("idle");
});

test("same-app takeover stops later chunks, persists for that app, and allows reads and other apps", async () => {
  const calls: string[] = [];
  let takeover = true;
  const { desktop } = setup({
    async typeText(_target: string, text: string) {
      calls.push(text);
      if (takeover) {
        const start = Date.now(),
          clock = spyOn(Date, "now");
        try {
          for (let at = 0; at <= 10000; at += 500) {
            clock.mockReturnValue(start + at);
            desktop.inputEvent({ type: "human", kind: "key", pid: 10 });
          }
        } finally {
          clock.mockRestore();
        }
      }
    },
  });
  const interrupted = await desktop.execute("one", [type()]);
  expect(interrupted.details).toMatchObject({
    interrupted: true,
    requiresManualResume: true,
  });
  expect(calls).toEqual(["abcdefghijklmnop"]);
  expect(desktop.state.pausedApps).toEqual(["Editor"]);
  expect(desktop.state.owner).toBeNull();
  takeover = false;
  await expect(desktop.execute("two", [type()])).rejects.toThrow("暂停");
  await desktop.execute("two", [capture, type("opaque-B", "other app")]);
  desktop.resume();
  await desktop.execute("one", [
    { method: "capture", args: ["opaque-A"] },
    type(),
  ]);
  expect(desktop.state.paused).toBe(false);
});

test("capture keeps desktop/default and opaque targets and ignores unavailable input monitor", async () => {
  const { desktop, calls } = setup();
  desktop.inputEvent({ type: "unavailable", reason: "test permissions" });
  desktop.pause();
  const result = await desktop.execute("one", [
    capture,
    { method: "capture", args: ["opaque-A"] },
  ]);
  expect(calls).toEqual(["desktop", "opaque-A"]);
  expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
  await expect(desktop.execute("one", [type()])).rejects.toThrow("输入监控");
});

test("human activity during a read-only batch never pauses input", async () => {
  const { desktop } = setup({
    async capture() {
      desktop.inputEvent({ type: "human", kind: "key", pid: 10 });
      return { data: new Uint8Array() };
    },
  });
  await desktop.execute("one", [capture, capture]);
  expect(desktop.state.paused).toBe(false);
});

test("missing event attribution pauses background input conservatively, unknown window never writes", async () => {
  const { desktop } = setup({
    async typeText() {
      desktop.inputEvent({ type: "human", kind: "pointer" });
    },
  });
  await expect(desktop.execute("one", [type()])).rejects.toThrow("暂停");
  desktop.resume();
  await expect(desktop.execute("one", [type("fake-window")])).rejects.toThrow(
    "无法确认目标",
  );
});

test("recent typing in the target is caught before the first write, other-app typing is allowed", async () => {
  const { desktop, calls } = setup();
  desktop.inputEvent({ type: "human", kind: "key", pid: 10 });
  desktop.inputEvent({ type: "human", kind: "key", pid: 20 });
  const interrupted = await desktop.execute("one", [type()]);
  expect(interrupted.details).toMatchObject({
    interrupted: true,
    requiresManualResume: false,
  });
  expect(calls).toHaveLength(0);
  await desktop.execute("one", [{ method: "capture", args: ["opaque-A"] }]);
  desktop.inputEvent({ type: "human", kind: "key", pid: 20 });
  await desktop.execute("one", [type()]);
});

test("AX references inherit observed target and reject cross-session or pre-resume reuse", async () => {
  const { desktop, calls } = setup();
  await desktop.execute("one", [
    { method: "axSnapshot", args: ["opaque-A"] },
    { method: "axChildren", args: ["e7"] },
  ]);
  await expect(
    desktop.execute("two", [{ method: "axSetValue", args: ["e8", "unsafe"] }]),
  ).rejects.toThrow("无法确认目标");
  await desktop.execute("one", [
    { method: "axSetValue", args: ["e8", "safe"] },
  ]);
  expect(calls).toEqual([["e8", "safe"]]);
  desktop.pause();
  desktop.resume();
  await expect(
    desktop.execute("one", [{ method: "axSetValue", args: ["e8", "old"] }]),
  ).rejects.toThrow("无法确认目标");
  await desktop.execute("one", [
    { method: "axQuery", args: ["opaque-A", {}] },
    { method: "axSetValue", args: ["e7", "new"] },
  ]);
});

test("recycled window handles cannot inherit old AX attribution", async () => {
  const { desktop, windows } = setup();
  await desktop.execute("one", [{ method: "axSnapshot", args: ["opaque-A"] }]);
  windows[0]!.pid = 30;
  await expect(
    desktop.execute("one", [{ method: "axSetValue", args: ["e7", "old"] }]),
  ).rejects.toThrow("无法确认目标");
});

test("explicit foreground action announces before input and any human movement stops it", async () => {
  const messages: string[] = [];
  const { desktop, calls } = setup({}, (message) => {
    messages.push(message);
    expect(calls).toHaveLength(0);
    expect(desktop.state.mode).toBe("foreground");
    desktop.inputEvent({ type: "human", kind: "move", pid: 20 });
  });
  const result = await desktop.execute("one", [
    { method: "click", args: ["opaque-A", 1, 2, { takeover: true }] },
  ]);
  expect(result.details).toMatchObject({
    interrupted: true,
    requiresManualResume: false,
  });
  expect(desktop.state.paused).toBe(false);
  expect(messages).toHaveLength(1);
  expect(calls).toHaveLength(0);
  await desktop.execute("one", [capture]);
});

test("desktop root writes are foreground, notify once per batch without requiring approval", async () => {
  const notices: string[] = [];
  const { desktop, calls } = setup({}, (text) => notices.push(text));
  await desktop.execute("one", [
    { method: "click", args: ["desktop", 1, 2] },
    type("desktop", "ok"),
  ]);
  expect(notices).toHaveLength(1);
  expect(calls).toHaveLength(2);
});

test("background focus stealing stops remaining writes", async () => {
  const { desktop, windows, calls } = setup({
    async typeText(_target: string, text: string) {
      calls.push(text);
      windows[0]!.focused = true;
      windows[1]!.focused = false;
    },
  });
  await expect(desktop.execute("one", [type()])).rejects.toThrow("暂停");
  expect(calls).toHaveLength(1);
  expect(desktop.state.reason).toContain("自行切到了前台");
});

test("backend without background input requires explicit takeover, not silent fallback", async () => {
  const { desktop, calls } = setup({
    capabilities: { backgroundWindowInput: false },
  });
  await expect(desktop.execute("one", [type()])).rejects.toThrow(
    "BackgroundUnavailable",
  );
  expect(calls).toHaveLength(0);
});

test("manual pause and cancelled queued execution cannot leak input or the desktop lock", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const { desktop, calls } = setup({
    async typeText(_target: string, text: string) {
      calls.push(text);
      entered();
      await hold;
    },
  });
  const first = desktop.execute("one", [type()]);
  await started;
  const second = desktop.execute("two", [type()]);
  desktop.cancel("two");
  await expect(second).rejects.toThrow();
  desktop.pause();
  release();
  await expect(first).rejects.toThrow("暂停");
  expect(calls).toHaveLength(1);
  await desktop.execute("three", [capture]);
  expect(desktop.state.owner).toBeNull();
});

test("missing input permission does not prevent enabling reads, refresh retries and preserves manual pause", async () => {
  const { desktop } = setup();
  let attempts = 0;
  (desktop as any).monitor = {
    async start() {
      attempts++;
      if (attempts === 1) throw new Error("permission denied");
      desktop.inputEvent({ type: "ready" });
    },
    stop() {},
  };
  desktop.state.enabled = false;
  desktop.state.detectorReady = false;
  await desktop.enable();
  expect(desktop.state.enabled).toBe(true);
  expect(desktop.state.detectorReady).toBe(false);
  await desktop.execute("one", [capture]);
  desktop.pause();
  await desktop.refresh();
  expect(desktop.state.detectorReady).toBe(true);
  expect(desktop.state.paused).toBe(true);
  await expect(desktop.execute("one", [type()])).rejects.toThrow("暂停");
  desktop.resume();
  await desktop.execute("one", [type()]);
  desktop.disable();
  desktop.inputEvent({ type: "ready" });
  expect(desktop.state.detectorReady).toBe(false);
});

test("brief input abandons the old batch and requires new target observation before automatic continuation", async () => {
  const calls: string[] = [];
  let intervene = true;
  const { desktop } = setup({
    async typeText(_target: string, text: string) {
      calls.push(text);
      if (intervene)
        desktop.inputEvent({ type: "human", kind: "key", pid: 10 });
    },
  });
  const result = await desktop.execute("one", [
    type(),
    { method: "click", args: ["opaque-A", 2, 3] },
  ]);
  expect(calls).toEqual(["abcdefghijklmnop"]);
  expect(result.details).toMatchObject({
    interrupted: true,
    requiresManualResume: false,
  });
  expect(JSON.parse(result.content.at(-1).text)).toMatchObject({
    completedOperations: 0,
    inputMayBePartial: true,
  });
  expect(desktop.state.paused).toBe(false);
  intervene = false;
  await expect(desktop.execute("one", [type()])).rejects.toThrow("重新观察");
  await desktop.execute("one", [{ method: "capture", args: ["opaque-B"] }]);
  await expect(desktop.execute("one", [type()])).rejects.toThrow("重新观察");
  await desktop.execute("one", [
    { method: "axSnapshot", args: ["opaque-A"] },
    type("opaque-A", "replanned"),
  ]);
  expect(calls).toEqual(["abcdefghijklmnop", "replanned"]);
});

test("a human focus change yields instead of being mistaken for application focus stealing", async () => {
  const { desktop, windows } = setup({
    async typeText() {
      windows[0]!.focused = true;
      windows[1]!.focused = false;
      desktop.inputEvent({ type: "human", kind: "pointer", pid: 10 });
    },
  });
  const result = await desktop.execute("one", [type()]);
  expect(result.details).toMatchObject({
    interrupted: true,
    requiresManualResume: false,
  });
  expect(desktop.state.paused).toBe(false);
});

test("nine seconds of intermittent input yields and recovers instead of locking a manual pause", async () => {
  const { desktop } = setup({
    async typeText() {
      const start = Date.now() - 9000,
        clock = spyOn(Date, "now");
      try {
        for (let at = 0; at <= 9000; at += 500) {
          clock.mockReturnValue(start + at);
          desktop.inputEvent({ type: "human", kind: "key", pid: 10 });
        }
      } finally {
        clock.mockRestore();
      }
    },
  });
  const result = await desktop.execute("one", [type()]);
  expect(result.details).toMatchObject({
    interrupted: true,
    requiresManualResume: false,
  });
  expect(desktop.state.paused).toBe(false);
});
