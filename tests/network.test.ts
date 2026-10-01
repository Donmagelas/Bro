import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../apps/host/server";
import { prepareRoot } from "../packages/platform/paths";
import { modelActivity, modelFailure } from "../packages/runtime-omp/progress";

test("retry progress survives a new attempt and clears for actual output or tools", () => {
  const retry = modelActivity({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 1000,
  });
  const waiting = modelActivity({ type: "turn_start" }, retry);
  expect(waiting).toMatchObject({
    phase: "waiting",
    attempt: 1,
    maxAttempts: 2,
  });
  expect(modelActivity({ type: "message_start" }, waiting)).toBe(waiting);
  expect(
    modelActivity(
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "working" }],
        },
      },
      waiting,
    )?.phase,
  ).toBe("responding");
  expect(
    modelActivity({ type: "tool_execution_start" }, waiting),
  ).toBeUndefined();
  expect(modelFailure("ConnectionRefused: Unable to connect")).toContain(
    "检查网络和代理",
  );
  expect(modelFailure("Stream first-event timeout")).toContain("模型响应超时");
  expect(modelFailure("401 Unauthorized")).toContain("身份验证失败");
});

test("real OMP retries are visible, exhausted requests fail, and the same session recovers", async () => {
  const root = mkdtempSync(join(tmpdir(), "bro-network-test-"));
  prepareRoot(root);
  let failing = true,
    hanging = false,
    requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.text();
      requests++;
      if (hanging)
        await new Promise<void>((resolve) =>
          req.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      if (failing)
        return Response.json(
          { error: { message: "Service unavailable", type: "server_error" } },
          { status: 503, headers: { "retry-after-ms": "10" } },
        );
      const frame = {
        id: "ok",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "RECOVERED" },
            finish_reason: null,
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const host = createHost(root, "network-test");
  host.store.saveConnection(
    {
      id: "fixture",
      name: "Fixture",
      kind: "api",
      provider: "bro-network",
      model: "fixture",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      api: "openai-completions",
      contextWindow: 128000,
      maxTokens: 100,
      reasoning: false,
      imageInput: false,
    },
    "fixture-key",
  );
  const session = host.store.createSession({
    title: "Network test",
    connectionId: "fixture",
  });
  const send = (id: string) => {
    host.store.enqueue(session.id, "Reply RECOVERED", { kind: "gui" }, { id });
    host.runtimes.wake(session.id);
  };
  const observed = new Set<string>();
  async function wait(id: string) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const phase = host.runtimes.modelActivity[session.id]?.phase;
      if (phase) observed.add(phase);
      const input = host.store.input(id);
      if (input && ["failed", "completed", "cancelled"].includes(input.status))
        return input;
      if (host.store.session(session.id)?.status === "error")
        throw new Error(host.store.session(session.id)?.error || "error");
      await Bun.sleep(20);
    }
    throw new Error(
      JSON.stringify({
        message: "runtime failed to settle",
        requests,
        observed: [...observed],
        session: host.store.session(session.id),
        input: host.store.input(id),
        activity: host.runtimes.modelActivity,
      }),
    );
  }
  try {
    send("fail");
    expect((await wait("fail")).status).toBe("failed");
    expect(observed.has("waiting")).toBe(true);
    expect(observed.has("retrying")).toBe(true);
    expect(host.store.session(session.id)?.status).toBe("error");
    expect(host.runtimes.modelActivity[session.id]).toBeUndefined();
    expect(requests).toBeGreaterThan(1);
    failing = false;
    send("recover");
    expect((await wait("recover")).status).toBe("completed");
    expect(JSON.stringify(await host.runtimes.history(session.id))).toContain(
      "RECOVERED",
    );
    expect(host.store.connections()).toHaveLength(1);
    hanging = true;
    const before = requests;
    send("cancel");
    const deadline = Date.now() + 10000;
    while (requests === before && Date.now() < deadline) await Bun.sleep(20);
    expect(requests).toBeGreaterThan(before);
    await host.runtimes.stop(session.id);
    expect((await wait("cancel")).status).toBe("cancelled");
    expect(host.runtimes.modelActivity[session.id]).toBeUndefined();
  } finally {
    await host.close();
    await provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
