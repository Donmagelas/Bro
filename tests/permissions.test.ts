import { expect, test } from "bun:test";
const { createPermissionFlow } = require("../apps/desktop/permissions.cjs");

function setup(platform = "darwin", granted = false) {
  const permissions: Record<string, boolean> = {
    screen: granted,
    accessibility: granted,
    inputMonitoring: granted,
  };
  const requests: any[] = [],
    opened: string[] = [],
    reports: any[] = [];
  const flow = createPermissionFlow({
    async request(_path: string, _method: string, body: any) {
      requests.push(body);
      return { platform, permissions: { ...permissions } };
    },
    async openExternal(url: string) {
      opened.push(url);
    },
    report(value: any) {
      reports.push(value);
    },
  });
  return { flow, permissions, requests, opened, reports };
}

test("one click requests only the first missing permission; returning advances without re-prompting a denial", async () => {
  const s = setup();
  await s.flow.check();
  expect(s.requests).toEqual([{}, { permission: "screen" }]);
  expect(s.opened[0]).toEndWith("?Privacy_ScreenCapture");
  await s.flow.check(true);
  expect(s.requests).toHaveLength(3);
  expect(s.opened).toHaveLength(1);
  expect(s.reports.at(-1).message).toContain("尚未授权");
  s.permissions.screen = true;
  await s.flow.check(true);
  expect(s.requests.at(-1)).toEqual({ permission: "accessibility" });
  expect(s.opened.at(-1)).toEndWith("?Privacy_Accessibility");
  s.permissions.accessibility = true;
  await s.flow.check(true);
  expect(s.opened.at(-1)).toEndWith("?Privacy_ListenEvent");
  s.permissions.inputMonitoring = true;
  await s.flow.check(true);
  expect(s.reports.at(-1).message).toBe("系统权限已就绪。");
  const count = s.requests.length;
  await s.flow.check(true);
  expect(s.requests).toHaveLength(count);
});

test("already granted permissions never prompt or open settings", async () => {
  const s = setup("darwin", true);
  await s.flow.check();
  expect(s.requests).toEqual([{}]);
  expect(s.opened).toEqual([]);
});

test("granted permissions with a cached denial ask to apply authorization instead of claiming readiness", async () => {
  const flow = createPermissionFlow({
    async request() {
      return {
        platform: "darwin",
        permissions: {
          screen: true,
          accessibility: true,
          inputMonitoring: true,
        },
        restartRequired: true,
      };
    },
    openExternal() {
      throw new Error("must not reopen granted settings");
    },
    report() {},
  });
  const result = await flow.check();
  expect(result.restartRequired).toBe(true);
  expect(result.message).toContain("应用授权");
  expect(result.message).not.toContain("已就绪");
});

test("a native grant advances immediately; duplicate clicks and focus share one request", async () => {
  const calls: any[] = [],
    reports: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const permissions = {
    screen: false,
    accessibility: true,
    inputMonitoring: true,
  };
  const flow = createPermissionFlow({
    async request(_path: string, _method: string, body: any) {
      calls.push(body);
      await gate;
      if (body.permission) permissions.screen = true;
      return { platform: "darwin", permissions: { ...permissions } };
    },
    openExternal() {
      throw new Error("must not open");
    },
    report(value: any) {
      reports.push(value);
    },
  });
  const first = flow.check(),
    second = flow.check(),
    focus = flow.check(true);
  release();
  await Promise.all([first, second, focus]);
  expect(calls).toEqual([{}, { permission: "screen" }]);
  expect(reports).toHaveLength(1);
  expect(reports[0].message).toBe("系统权限已就绪。");
});

test("leaving settings cancels automatic progression, including an in-flight check", async () => {
  const s = setup();
  await s.flow.check();
  s.flow.cancel();
  s.permissions.screen = true;
  await s.flow.check(true);
  expect(s.opened).toHaveLength(1);
  const pending = s.flow.check();
  s.flow.cancel();
  await pending;
  expect(s.opened).toHaveLength(1);
  expect(s.requests.at(-1)).toEqual({});
});

test("Windows reports checks without opening fictitious privacy pages or requesting elevation", async () => {
  const s = setup("win32", true);
  await s.flow.check();
  expect(s.reports.at(-1).message).toContain("无需额外授权");
  s.permissions.accessibility = false;
  await s.flow.check();
  expect(s.reports.at(-1).message).toContain("没有统一授权开关");
  expect(s.opened).toEqual([]);
  expect(s.requests).toEqual([{}, {}]);
});

test("native request failures remain retryable", async () => {
  let fails = true;
  const flow = createPermissionFlow({
    async request() {
      if (fails) throw new Error("native unavailable");
      return {
        platform: "darwin",
        permissions: {
          screen: true,
          accessibility: true,
          inputMonitoring: true,
        },
      };
    },
    openExternal() {
      throw new Error("must not open");
    },
    report() {},
  });
  await expect(flow.check()).rejects.toThrow("native unavailable");
  fails = false;
  expect((await flow.check()).message).toBe("系统权限已就绪。");
});
