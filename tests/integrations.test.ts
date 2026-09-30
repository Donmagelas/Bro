import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/host/store";
import { Monitor, readSSE } from "../packages/integrations/monitor";
import { splitText } from "../packages/integrations/text";
import { prepareRoot } from "../packages/platform/paths";
import { createJudge } from "../packages/experiments/selection";

test("SSE preserves split CRLF, multibyte text, multiline payload, and peer replay boundary", async () => {
  const bytes = new TextEncoder().encode(
    "id: 7\r\ndata: 中文\r\ndata: second\r\n\r\n: replay-end\n\n",
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
      c.close();
    },
  });
  const events = [];
  for await (const e of readSSE(stream)) events.push(e);
  expect(events).toEqual([
    { id: "7", data: "中文\nsecond", replayEnd: false },
    { id: undefined, data: "", replayEnd: true },
  ]);
});
test("long Chinese and emoji replies remain complete and within byte limits", () => {
  const original = "汉字🙂\n".repeat(10000);
  const parts = splitText(original);
  expect(parts.join("")).toBe(original);
  expect(parts.every((p) => Buffer.byteLength(p) <= 12000)).toBe(true);
});
test("Peer checks source and receiver before queueing; external correlation cannot set internal request IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "bro-peer-"));
  prepareRoot(root);
  const store = new Store(root),
    monitor = new Monitor(
      store,
      () => {},
      () => {},
    );
  try {
    const target = store.createSession(),
      sub = {
        id: "relay",
        kind: "peer" as const,
        name: "Peer",
        enabled: true,
        targetSessionId: target.id,
        me: "bro",
        trustedSenders: ["owner"],
      };
    monitor.receive(
      sub,
      JSON.stringify({ seq: 1, to: "bro", from: "stranger", body: "hello" }),
    );
    expect(store.inputs(target.id)).toHaveLength(0);
    const record = {
      seq: 2,
      to: "bro",
      from: "owner",
      body: "hello",
      corrId: "forged-internal-id",
    };
    monitor.receive(sub, JSON.stringify(record));
    monitor.receive(sub, JSON.stringify(record));
    const inputs = store.inputs(target.id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.source.correlationId).toBe("forged-internal-id");
    expect(inputs[0]?.parentRequestId).toBeNull();
    expect(inputs[0]?.status).toBe("queued");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("native OMP TypeSafe client uses the documented shared Jev/Laya wire protocol", async () => {
  let path = "",
    body: any;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      path = new URL(req.url).pathname;
      body = await req.json();
      return Response.json({
        model: "fixture",
        answers: { a: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    },
  });
  try {
    const judge = createJudge(
      {
        skills: "experimental",
        context: "normal",
        compression: "normal",
        backend: "laya",
        endpoint: `http://127.0.0.1:${server.port}`,
        model: "multilingual",
      },
      "",
    );
    const result = await judge("task", [{ id: "a", text: "candidate" }]);
    expect(path).toBe("/v1/systemone");
    expect(body.questions.a.type).toBe("noul");
    expect(result.scores.a).toBe(0.9);
  } finally {
    await server.stop(true);
  }
});

test("stopping Monitor settles an in-flight reply and prevents sends after database closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "bro-monitor-close-"));
  prepareRoot(root);
  const store = new Store(root);
  let received!: () => void;
  const incoming = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return Response.json({ ok: true });
    },
  });
  const monitor = new Monitor(
    store,
    () => {},
    () => {},
  );
  try {
    const session = store.createSession();
    store.saveSubscription({
      id: "peer",
      name: "fixture",
      kind: "peer",
      enabled: true,
      targetSessionId: session.id,
      url: `http://127.0.0.1:${server.port}`,
      me: "bro",
      trustedSenders: ["owner"],
    });
    store.addReply(
      "reply",
      { kind: "peer", connectionId: "peer", senderId: "owner" },
      "result",
    );
    const sending = monitor.flush();
    await incoming;
    await monitor.stop();
    await sending;
    expect((store.replies()[0] as any)?.status).toBe("uncertain");
    store.close();
    await monitor.flush();
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Skill directories load directly, preserve metadata, and exclude sibling directories", async () => {
  const { loadBroSkills } = await import("../packages/runtime-omp/resources");
  const root = mkdtempSync(join(tmpdir(), "bro-skill-root-"));
  try {
    for (const name of ["chosen", "unrelated"]) {
      mkdirSync(join(root, name));
      writeFileSync(
        join(root, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Test fixture\nhide: true\n---\nFixture.`,
      );
    }
    const direct = await loadBroSkills(join(root, "chosen"), "bro:user");
    expect(direct.skills.map((s: any) => s.name)).toEqual(["chosen"]);
    expect(direct.skills[0].baseDir).toBe(join(root, "chosen"));
    expect(direct.skills[0].hide).toBe(true);
    const collection = await loadBroSkills(root, "bro:project");
    expect(collection.skills.map((s: any) => s.name)).toEqual([
      "chosen",
      "unrelated",
    ]);
    expect(
      collection.skills.every((s: any) => s.source === "bro:project"),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
