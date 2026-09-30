import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/host/store";
import { Feishu } from "../packages/integrations/feishu";
import { FeishuSetup } from "../packages/integrations/feishu-setup";
import { prepareRoot } from "../packages/platform/paths";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const begin = {
  device_code: "private-device",
  user_code: "test code",
  expire_in: 60,
  interval: 0.001,
};
const credentials = {
  client_id: "cli_new",
  client_secret: "private-secret",
  user_info: { open_id: "ou_creator", tenant_brand: "feishu" },
};
function harness(
  polls: any[] = [credentials],
  options: { botFail?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "bro-feishu-setup-"));
  roots.push(root);
  prepareRoot(root);
  const store = new Store(root);
  const calls: { url: string; body: string; headers: Headers }[] = [];
  const transport = (async (url: any, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init.body || ""),
      headers: new Headers(init.headers),
    });
    expect(init.redirect).toBe("error");
    if (String(url).endsWith("/registration")) {
      const action = new URLSearchParams(String(init.body)).get("action");
      return Response.json(
        action === "begin"
          ? begin
          : polls.shift() || { error: "expired_token" },
      );
    }
    if (String(url).endsWith("/internal"))
      return Response.json({
        code: 0,
        tenant_access_token: "private-tenant-token",
      });
    if (options.botFail)
      return Response.json({
        code: 999,
        msg: "private-secret should not be shown",
      });
    return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
  }) as typeof fetch;
  const feishu = new Feishu(
    store,
    () => {},
    () => {
      throw Error("pairing must not start a model");
    },
  );
  let starts = 0;
  feishu.start = async () => {
    starts++;
    (feishu as any).stopped = false;
  };
  let setup = new FeishuSetup(
    store,
    feishu,
    () => {},
    transport,
    async () => {},
  );
  feishu.onPairingMessage = (event, config) =>
    setup.receivePairing(event, config);
  return {
    store,
    feishu,
    calls,
    get setup() {
      return setup;
    },
    get starts() {
      return starts;
    },
    recreate() {
      setup = new FeishuSetup(
        store,
        feishu,
        () => {},
        transport,
        async () => {},
      );
    },
    async close() {
      await setup.close();
      await feishu.stop();
      store.close();
    },
  };
}
const settle = (setup: FeishuSetup) => (setup as any).work as Promise<void>;
function event(text: string, extra: any = {}) {
  return {
    sender: { sender_id: { open_id: "ou_person" }, sender_type: "user" },
    message: {
      message_id: "pairing-msg",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      ...extra,
    },
  };
}

test("registration creates once, binds the verified creator, and exposes no credentials", async () => {
  const h = harness([
    { error: "authorization_pending" },
    { error: "slow_down" },
    credentials,
  ]);
  try {
    h.store.setConfig("feishu", {
      appId: "old",
      appSecret: "old-secret",
      enabled: true,
    });
    h.store.setConfig("settings", {
      ...h.store.getSettings(),
      trustedFeishuUsers: ["ou_old"],
    });
    expect(() => h.setup.start()).toThrow("已有飞书连接");
    h.setup.start(true);
    h.setup.start(true);
    await settle(h.setup);
    expect(h.setup.state().status).toBe("ready");
    expect(h.store.getSettings().trustedFeishuUsers).toEqual(["ou_creator"]);
    expect(h.store.getConfig<any>("feishu", null)).toEqual({
      appId: "cli_new",
      appSecret: "private-secret",
      botId: "ou_bot",
      enabled: true,
    });
    expect(h.starts).toBe(1);
    expect(h.calls.filter((c) => c.body.includes("action=begin"))).toHaveLength(
      1,
    );
    expect(new URLSearchParams(h.calls[0]!.body).get("request_user_info")).toBe(
      "open_id tenant_brand",
    );
    expect(JSON.stringify(h.setup.state())).not.toMatch(
      /private-|appSecret|deviceCode/,
    );
    expect(JSON.stringify(h.store.getConfig("feishuSetup", null))).not.toMatch(
      /private-|appSecret|deviceCode/,
    );
    expect(h.calls.at(-1)?.headers.get("Authorization")).toBe(
      "Bearer private-tenant-token",
    );
  } finally {
    await h.close();
  }
});

test("created credentials survive a failed connection and restart without creating another app", async () => {
  const options = { botFail: true };
  const h = harness([credentials], options);
  try {
    h.store.setConfig("feishu", {
      appId: "old",
      appSecret: "old-secret",
      enabled: true,
    });
    h.store.setConfig("settings", {
      ...h.store.getSettings(),
      trustedFeishuUsers: ["ou_old"],
    });
    h.setup.start(true);
    await settle(h.setup);
    expect(h.setup.state().status).toBe("error");
    expect(h.setup.state().error).not.toContain("private-secret");
    expect(h.store.getConfig<any>("feishu", null).appId).toBe("old");
    expect(h.store.getSettings().trustedFeishuUsers).toEqual(["ou_old"]);
    await h.setup.close();
    h.recreate();
    h.setup.resume();
    expect(h.setup.state().status).toBe("error");
    options.botFail = false;
    h.setup.start(true);
    await settle(h.setup);
    expect(h.setup.state().status).toBe("ready");
    expect(h.calls.filter((c) => c.body.includes("action=begin"))).toHaveLength(
      1,
    );
  } finally {
    await h.close();
  }
});

test("missing identity requires a single-use, private-chat pairing code and never runs a model", async () => {
  const h = harness([{ ...credentials, user_info: undefined }]);
  try {
    h.setup.start();
    await settle(h.setup);
    expect(h.store.getSettings().trustedFeishuUsers).toEqual([]);
    expect(h.setup.state().status).toBe("pairing");
    const config = h.store.getConfig<any>("feishu", null),
      code = h.setup.state().pairingCode!;
    await h.feishu.receive(event("hi"), config);
    await h.feishu.receive(event(code, { chat_type: "group" }), config);
    await h.feishu.receive(event(code), { ...config, appId: "other" });
    expect(h.store.getSettings().trustedFeishuUsers).toEqual([]);
    await h.feishu.receive(event(code), config);
    expect(h.setup.state()).toMatchObject({
      status: "ready",
      ownerOpenId: "ou_person",
    });
    expect(h.setup.state().pairingCode).toBeUndefined();
    expect(h.store.getSettings().trustedFeishuUsers).toEqual(["ou_person"]);
    expect(h.store.sessions()).toHaveLength(0);
    expect(h.setup.receivePairing(event(code), config)).toBe(false);
    const fresh = h.setup.pair();
    expect(fresh.pairingCode).not.toBe(code);
    expect(h.setup.receivePairing(event(code), config)).toBe(false);
    (h.setup as any).record.pairingExpiresAt = Date.now() - 1;
    expect(h.setup.receivePairing(event(fresh.pairingCode!), config)).toBe(
      false,
    );
  } finally {
    await h.close();
  }
});

test("expiry, denial and unsupported tenant never save credentials or trust", async () => {
  for (const [result, status] of [
    [{ error: "expired_token" }, "expired"],
    [{ error: "access_denied" }, "cancelled"],
    [{ ...credentials, user_info: { tenant_brand: "lark" } }, "error"],
  ] as const) {
    const h = harness([result]);
    try {
      h.setup.start();
      await settle(h.setup);
      expect(h.setup.state().status).toBe(status);
      expect(h.store.getConfig("feishu", null)).toBeNull();
      expect(h.store.getSettings().trustedFeishuUsers).toEqual([]);
    } finally {
      await h.close();
    }
  }
});

test("pending QR state resumes after restart and cancellation drains all work", async () => {
  const h = harness();
  let started!: () => void;
  const reached = new Promise<void>((r) => {
    started = r;
  });
  const transport = (async (_url: any, init: RequestInit) => {
    if (new URLSearchParams(String(init.body)).get("action") === "begin")
      return Response.json(begin);
    started();
    return new Promise((_r, reject) =>
      init.signal!.addEventListener("abort", () => reject(Error("aborted")), {
        once: true,
      }),
    );
  }) as typeof fetch;
  const s = new FeishuSetup(h.store, h.feishu, () => {}, transport);
  try {
    s.start();
    await reached;
    expect(s.state().qrCode).toStartWith("data:image/gif;base64,");
    expect(s.state().verificationUrl).toBe(
      "https://open.feishu.cn/page/cli?user_code=test%20code",
    );
    expect(JSON.stringify(s.state())).not.toContain("private-device");
    await s.close();
    h.recreate();
    h.setup.resume();
    await settle(h.setup);
    expect(h.setup.state().status).toBe("ready");
    expect(h.calls.some((c) => c.body.includes("action=begin"))).toBe(false);
    await h.setup.clear();
    expect(h.setup.state()).toEqual({ status: "idle" });
  } finally {
    await s.close();
    await h.close();
  }
});

test("cancel while polling preserves the existing app and prevents late writes", async () => {
  const h = harness([{ error: "authorization_pending" }]);
  let entered!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const wait = async (_ms: number, signal: AbortSignal) => {
    entered();
    await new Promise((_r, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      }),
    );
  };
  const transport = (async (_url: any, init: RequestInit) =>
    Response.json(
      new URLSearchParams(String(init.body)).get("action") === "begin"
        ? begin
        : { error: "authorization_pending" },
    )) as typeof fetch;
  const s = new FeishuSetup(h.store, h.feishu, () => {}, transport, wait);
  try {
    h.store.setConfig("feishu", {
      appId: "old",
      appSecret: "old-secret",
      enabled: true,
    });
    s.start(true);
    await reached;
    await s.cancel();
    expect(s.state().status).toBe("cancelled");
    expect(h.store.getConfig<any>("feishu", null).appId).toBe("old");
    expect(JSON.stringify(s.state())).not.toContain("private-device");
  } finally {
    await s.close();
    await h.close();
  }
});
