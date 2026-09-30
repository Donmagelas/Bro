import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/host/store";
import { Feishu } from "../packages/integrations/feishu";
import { prepareRoot } from "../packages/platform/paths";

const config = {
  appId: "app",
  appSecret: "unused",
  botId: "bot",
  enabled: true,
};
function event(id: string, sender = "owner", group = false, mention = false) {
  return {
    sender: { sender_id: { open_id: sender } },
    message: {
      message_id: id,
      chat_id: group ? "group" : "dm",
      chat_type: group ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "收到后处理这条消息" }),
      mentions: mention ? [{ id: { open_id: "bot" }, key: "@bot" }] : [],
    },
  };
}
function setup(request: (payload: any) => Promise<any>) {
  const root = mkdtempSync(join(tmpdir(), "bro-feishu-receipt-"));
  prepareRoot(root);
  const store = new Store(root);
  store.setConfig("settings", {
    ...store.getSettings(),
    trustedFeishuUsers: ["owner"],
  });
  const wakes: string[] = [];
  const feishu = new Feishu(
    store,
    () => {},
    (id) => wakes.push(id),
  );
  // Exercise real ingestion/deduplication with only the platform transport stubbed.
  (feishu as any).client = { request };
  return {
    store,
    feishu,
    wakes,
    async close() {
      await feishu.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Feishu acknowledges accepted DMs and group mentions once, after durable ingestion", async () => {
  const requests: any[] = [];
  const h = setup(async (payload) => {
    expect(
      h.store.sessions().some((s) => h.store.inputs(s.id).length > 0),
    ).toBe(true);
    requests.push(payload);
    return { code: 0 };
  });
  try {
    await h.feishu.receive(event("untrusted", "stranger"), config);
    await h.feishu.receive(event("not-mentioned", "owner", true), config);
    expect(requests).toHaveLength(0);
    expect(h.store.sessions()).toHaveLength(0);
    await Promise.all([
      h.feishu.receive(event("dm-1"), config),
      h.feishu.receive(event("dm-1"), config),
    ]);
    await h.feishu.receive(event("group-1", "owner", true, true), config);
    expect(requests.map((r) => r.url)).toEqual([
      "/open-apis/im/v1/messages/dm-1/reactions",
      "/open-apis/im/v1/messages/group-1/reactions",
    ]);
    expect(
      requests.every(
        (r) => r.method === "POST" && r.data.reaction_type.emoji_type === "Get",
      ),
    ).toBe(true);
    expect(
      requests.every(
        (r) => r.timeout === 5000 && r.signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(h.wakes).toHaveLength(2);
    expect(
      h.store.sessions().flatMap((s) => h.store.inputs(s.id)),
    ).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("a pending Feishu reaction does not delay execution and is drained on shutdown", async () => {
  let complete!: (value: any) => void;
  const h = setup(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    const receiving = h.feishu.receive(event("slow"), config);
    expect(h.wakes).toHaveLength(1);
    expect(h.store.inputs(h.wakes[0]!)[0]?.status).toBe("queued");
    let stopped = false;
    const stopping = h.feishu.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    complete({ code: 0 });
    await receiving;
    await stopping;
    await h.feishu.receive(event("after-stop"), config);
    expect(h.wakes).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("Feishu receipt permission and network failures preserve the queued task", async () => {
  let calls = 0;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const h = setup(async () => {
    if (++calls === 1) return { code: 99991672 };
    throw new Error("transport failure");
  });
  try {
    await h.feishu.receive(event("permission-denied"), config);
    await h.feishu.receive(event("network-error"), config);
    expect(h.wakes).toHaveLength(2);
    expect(h.store.inputs(h.wakes[0]!).map((i) => i.status)).toEqual([
      "queued",
      "queued",
    ]);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(h.feishu.status.error).toBeUndefined();
  } finally {
    await h.close();
    warning.mockRestore();
  }
});
