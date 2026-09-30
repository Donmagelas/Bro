import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountAuth } from "../apps/host/auth";
import { Store } from "../apps/host/store";

const account = {
  ok: true,
  credentialId: 1,
  accessToken: "fixture-secret",
  accountId: "fixture-account",
  email: "fixture@example.test",
};

test("quota reads real OMP windows, caches polls, refreshes explicitly and never returns credentials or stale balances", async () => {
  const root = mkdtempSync(join(tmpdir(), "bro-quota-"));
  const store = new Store(root),
    auth = new AccountAuth(store, () => {});
  await auth.status();
  const access = spyOn(
    (auth as any).storage.oauth,
    "accessAll",
  ).mockResolvedValue([account]);
  let calls = 0,
    failed = false;
  let payload: any = {
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18000,
        reset_at: 2000000000,
      },
      secondary_window: {
        used_percent: 100,
        limit_window_seconds: 604800,
        reset_at: 2000100000,
      },
    },
    credits: { balance: "12.5", unlimited: false },
  };
  const request = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    options,
  ) => {
    expect(String(url).startsWith("https://chatgpt.com/backend-api/")).toBe(
      true,
    );
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer fixture-secret",
    );
    if (String(url).endsWith("wham/usage")) {
      calls++;
      return Response.json(payload, { status: failed ? 401 : 200 });
    }
    return Response.json({ programs: [] });
  }) as typeof fetch);
  try {
    const [first, same] = await Promise.all([auth.quota(), auth.quota()]);
    expect(first).toEqual(same);
    expect(first.status).toBe("ready");
    expect(first.accounts[0]?.windows).toEqual([
      {
        id: "openai-codex:primary",
        label: "5 小时",
        remainingPercent: 75,
        resetsAt: 2000000000000,
      },
      {
        id: "openai-codex:secondary",
        label: "每周",
        remainingPercent: 0,
        resetsAt: 2000100000000,
      },
    ]);
    expect(first.accounts[0]?.credits?.balance).toBe(12.5);
    expect(JSON.stringify(first)).not.toContain("fixture-secret");
    expect(JSON.stringify(first)).not.toContain("fixture-account");
    await auth.quota();
    expect(calls).toBe(1);
    payload = {
      rate_limit: {
        primary_window: { used_percent: 6, limit_window_seconds: 604800 },
      },
    };
    const weekly = await auth.quota(true);
    expect(weekly.accounts[0]?.windows).toHaveLength(1);
    expect(weekly.accounts[0]?.windows[0]).toMatchObject({
      label: "每周",
      remainingPercent: 94,
      resetsAt: null,
    });
    expect(calls).toBe(2);
    failed = true;
    const unavailable = await auth.quota(true);
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.accounts[0]?.windows).toEqual([]);
    access.mockResolvedValue([]);
    await auth.logout();
    expect((await auth.quota()).status).toBe("signed_out");
  } finally {
    request.mockRestore();
    access.mockRestore();
    await auth.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("host shutdown aborts in-flight quota reads before closing authentication storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "bro-quota-close-"));
  const store = new Store(root),
    auth = new AccountAuth(store, () => {});
  await auth.status();
  const access = spyOn(
    (auth as any).storage.oauth,
    "accessAll",
  ).mockResolvedValue([account]);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const request = spyOn(globalThis, "fetch").mockImplementation((async (
    _url,
    options,
  ) => {
    started();
    return new Promise<Response>((_resolve, reject) =>
      options?.signal?.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true },
      ),
    );
  }) as typeof fetch);
  const close = spyOn((auth as any).storage, "close");
  try {
    const pending = auth.quota();
    await ready;
    await auth.close();
    expect((await pending).status).toBe("unavailable");
    expect(close).toHaveBeenCalledTimes(1);
    await expect(auth.quota()).rejects.toThrow("认证服务已关闭");
  } finally {
    request.mockRestore();
    access.mockRestore();
    close.mockRestore();
    await auth.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
