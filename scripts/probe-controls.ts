import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRoot } from "../packages/platform/paths";
import { createHost } from "../apps/host/server";
const root = mkdtempSync(join(tmpdir(), "bro-controls-"));
prepareRoot(root);
writeFileSync(
  join(root, "agent/config.yml"),
  "compaction:\n  keepRecentTokens: 100\n",
);
let compacting = false,
  compactionRequest = false;
const seen: string[] = [];
const requests: { model: string; effort?: string }[] = [];
let finishSwitch: (() => void) | undefined;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as any;
    requests.push({ model: body.model, effort: body.reasoning_effort });
    const last = body.messages.findLast((m: any) => m.role === "user");
    const text =
      typeof last.content === "string"
        ? last.content
        : last.content.map((c: any) => c.text || "").join("\n");
    if (compacting) {
      compactionRequest = true;
      await Bun.sleep(500);
    }
    const marker =
      ["FIRST", "STEER", "SECOND", "CANCEL", "SHUTDOWN"].find((x) =>
        text.includes(`BRO_${x}`),
      ) || "UNKNOWN";
    seen.push(marker);
    if (text.includes("BRO_MODEL_SWITCH_FIRST"))
      await new Promise<void>((resolve) => {
        finishSwitch = resolve;
      });
    if (marker === "FIRST") await Bun.sleep(700);
    if (marker === "CANCEL" || marker === "SHUTDOWN")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10000);
        req.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    const frame = {
      id: "control",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: compacting
              ? "Summary: the completed first and steer tasks are preserved; queued work remains to run."
              : `DONE_${marker} ` +
                Array.from(
                  { length: 30 },
                  (_, n) => `Observation ${n}: ${crypto.randomUUID()}.`,
                ).join(" "),
          },
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
const host = createHost(root, "probe");
async function until(condition: () => boolean) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 45000) throw new Error("Timeout");
    await Bun.sleep(25);
  }
}
try {
  host.store.saveConnection(
    {
      id: "fixture",
      name: "Fixture",
      kind: "api",
      provider: "bro-fixture",
      model: "fixture",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      api: "openai-completions",
      contextWindow: 128000,
      maxTokens: 16000,
      reasoning: false,
      imageInput: false,
    },
    "fixture",
  );
  const session = host.store.createSession({
    title: "Runtime probe",
    connectionId: "fixture",
  });
  const first = host.store.enqueue(session.id, "BRO_FIRST", { kind: "gui" });
  host.runtimes.wake(session.id);
  await until(() => seen.includes("FIRST"));
  const second = host.store.enqueue(session.id, "BRO_SECOND", { kind: "gui" });
  host.runtimes.wake(session.id);
  await host.runtimes.steer(session.id, {
    id: "steer-input",
    sessionId: session.id,
    text: "BRO_STEER",
    source: { kind: "gui" },
    annotations: [
      { messageId: "probe", quote: "FIRST", comment: "steer annotation" },
    ],
    attachments: [],
  });
  await until(() => host.store.input(second.id)?.status === "completed");
  if (seen.join(",") !== "FIRST,STEER,SECOND")
    throw new Error(`Wrong execution order ${seen.join(",")}`);
  const history = await host.runtimes.history(session.id);
  if (!JSON.stringify(history).includes("steer annotation"))
    throw new Error("Steer annotation missing");
  const cancel = host.store.enqueue(session.id, "BRO_CANCEL", { kind: "gui" });
  host.runtimes.wake(session.id);
  await until(() => seen.includes("CANCEL"));
  await host.runtimes.stop(session.id);
  await until(() => host.store.input(cancel.id)?.status === "cancelled");
  if (host.store.input(first.id)?.status !== "completed")
    throw new Error("First prompt did not complete");
  compacting = true;
  const maintenance = host.runtimes.compact(session.id);
  let compactFailure: unknown;
  void maintenance.catch((error) => {
    compactFailure = error;
  });
  await until(() => compactionRequest || !!compactFailure);
  if (compactFailure) throw compactFailure;
  const queuedDuringCompact = host.store.enqueue(
    session.id,
    "BRO_AFTER_COMPACT",
    { kind: "gui" },
  );
  host.runtimes.wake(session.id);
  if (host.store.input(queuedDuringCompact.id)?.status !== "queued")
    throw new Error("Queued task raced manual compaction");
  await maintenance;
  compacting = false;
  await until(
    () => host.store.input(queuedDuringCompact.id)?.status === "completed",
  );
  const stats = await host.runtimes.stats(session.id);
  if (!stats.context?.tokens)
    throw new Error("Native context usage unavailable");
  const config = host.store.connection("fixture")!;
  for (const [id, model] of [
    ["model-a", "gpt-5.4"],
    ["model-b", "gpt-5.3-codex"],
  ])
    host.store.saveConnection(
      {
        ...config,
        id: id!,
        provider: `bro-${id}`,
        model: model!,
        reasoning: true,
      },
      "fixture",
    );
  const switchSession = host.store.createSession({
    title: "Model switch probe",
    connectionId: "model-a",
    thinking: "high",
  });
  const requestIndex = requests.length;
  const beforeSwitch = host.store.enqueue(
    switchSession.id,
    "BRO_MODEL_SWITCH_FIRST",
    { kind: "gui" },
  );
  host.runtimes.wake(switchSession.id);
  await until(() => !!finishSwitch);
  const changed = await fetch(
    `http://127.0.0.1:${host.server.port}/sessions/${switchSession.id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: "Bearer probe",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectionId: "model-b", thinking: "low" }),
    },
  );
  if (!changed.ok)
    throw new Error(`Active model switch failed: ${await changed.text()}`);
  if (host.store.input(beforeSwitch.id)?.status !== "running")
    throw new Error("Model switch interrupted the active turn");
  const afterSwitch = host.store.enqueue(
    switchSession.id,
    "BRO_MODEL_SWITCH_NEXT",
    { kind: "gui" },
  );
  host.runtimes.wake(switchSession.id);
  finishSwitch!();
  const reads: Promise<unknown>[] = [];
  const readErrors: unknown[] = [];
  const refreshTimer = setInterval(() => {
    reads.push(
      Promise.all([
        host.runtimes.history(switchSession.id),
        host.runtimes.stats(switchSession.id),
      ]).catch((e) => readErrors.push(e)),
    );
  }, 10);
  try {
    await until(() => host.store.input(afterSwitch.id)?.status === "completed");
  } finally {
    clearInterval(refreshTimer);
    await Promise.all(reads);
  }
  if (readErrors.length)
    throw new Error(`Read failed during model switch: ${readErrors[0]}`);
  const switchedRequests = requests.slice(requestIndex);
  if (
    JSON.stringify(switchedRequests) !==
    JSON.stringify([
      { model: "gpt-5.4", effort: "high" },
      { model: "gpt-5.3-codex", effort: "low" },
    ])
  )
    throw new Error(
      `Wrong models or reasoning on the wire: ${JSON.stringify(switchedRequests)}`,
    );
  if (host.store.input(beforeSwitch.id)?.status !== "completed")
    throw new Error("Previous turn was lost");
  const duringShutdown = host.store.enqueue(session.id, "BRO_SHUTDOWN", {
    kind: "gui",
  });
  host.runtimes.wake(session.id);
  await until(() => seen.includes("SHUTDOWN"));
  await host.close();
  console.log(
    JSON.stringify({ shutdownCompleted: true, lastInput: duringShutdown.id }),
  );
  console.log(
    JSON.stringify({
      passed: true,
      root,
      seen,
      proofs: [
        "steer applied during the active turn with annotations",
        "queued input runs afterward",
        "stop cancels real OMP provider request",
        "manual compaction serializes queued input",
        "native context statistics",
        "active model change preserves the current request and switches model/effort for the queued turn",
        "host shutdown settles active worker",
      ],
    }),
  );
} catch (error) {
  console.error(error);
  console.error("Probe root", root);
  process.exitCode = 1;
} finally {
  await host.close();
  await provider.stop(true);
}
