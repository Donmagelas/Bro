import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRoot } from "../packages/platform/paths";
import { createHost } from "../apps/host/server";
const root = mkdtempSync(join(tmpdir(), "bro-memory-probe-"));
prepareRoot(root);
// Use bro's FTS-only baseline; disable extraction and retain every turn to make
// native automatic retain/recall deterministic without an extraction model.
writeFileSync(
  join(root, "agent/config.yml"),
  "mnemopi:\n  llmMode: none\n  retainEveryNTurns: 1\n",
);
let lastContext = "";
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.json();
    lastContext = JSON.stringify(body);
    const frame = {
      id: "memory",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "Project BRO_CEDAR uses PORT_4517 for its local service.",
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
async function send(id: string, text: string) {
  const input = host.store.enqueue(id, text, { kind: "gui" });
  host.runtimes.wake(id);
  for (let i = 0; i < 600; i++) {
    const row = host.store.input(input.id);
    if (row?.status === "completed") return;
    if (row?.status === "failed" || host.store.session(id)?.status === "error")
      throw new Error(
        row?.error || host.store.session(id)?.error || "memory failed",
      );
    await Bun.sleep(50);
  }
  throw new Error("Memory timeout");
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
  host.store.setConfig("settings", {
    ...host.store.getSettings(),
    defaultConnectionId: "fixture",
    memory: true,
  });
  const first = host.store.createSession({ title: "Memory probe" });
  await send(
    first.id,
    "Project BRO_CEDAR uses PORT_4517 for its local service. Keep this fact in the project notes.",
  );
  await host.runtimes.release(first.id);
  const second = host.store.createSession({ title: "Memory probe" });
  await send(second.id, "BRO_CEDAR");
  const status = await host.runtimes.memory(second.id);
  const recalled = await host.runtimes.memory(second.id, "BRO_CEDAR PORT_4517");
  if (
    !status.active ||
    !recalled.count ||
    !JSON.stringify(recalled).includes("PORT_4517")
  )
    throw new Error(
      `Memory recall missing: ${JSON.stringify({ status, recalled })}`,
    );
  writeFileSync(join(root, "recall-context.json"), lastContext);
  if (!lastContext.includes("PORT_4517"))
    throw new Error(
      "Automatic recall not injected into the fresh conversation",
    );
  host.store.setConfig("settings", {
    ...host.store.getSettings(),
    memory: false,
  });
  await host.runtimes.refresh();
  const third = host.store.createSession({ title: "Memory probe" });
  await send(third.id, "Say hello");
  if (lastContext.includes("PORT_4517") || lastContext.includes("BRO_CEDAR"))
    throw new Error("Memory remained in fresh context after off");
  const off = await host.runtimes.memory(third.id);
  if (off.active || off.backend !== "off")
    throw new Error("Memory did not turn off");
  console.log(
    JSON.stringify({
      passed: true,
      root,
      status,
      proofs: [
        "native automatic retain",
        "new-session FTS recall and provider injection",
        "off prevents fresh-session recall",
      ],
      limits:
        "bro FTS-only baseline; vector retrieval is deferred; production extraction model remains unverified",
    }),
  );
} catch (e) {
  console.error(e);
  console.error("Probe root", root);
  process.exitCode = 1;
} finally {
  await host.close();
  await provider.stop(true);
}
