import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRoot } from "../packages/platform/paths";
import { createHost } from "../apps/host/server";

// This deterministic provider fixture verifies the real OMP/tool/IPC path,
// not a real model account or the quality of model reasoning.
const root = mkdtempSync(join(tmpdir(), "bro-omp-probe-"));
prepareRoot(root);
let requests = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const data = (await req.json()) as any;
    requests++;
    const names = (data.tools || []).map((t: any) => t.function?.name);
    console.log("Provider request", requests, "tools", names.join(","));
    const hasResult = (data.messages || []).some((m: any) => m.role === "tool");
    const tool = names.includes("write")
      ? "write"
      : names.includes("eval")
        ? "eval"
        : undefined;
    const path = join(root, "workspaces", "proof.txt");
    const args =
      tool === "write"
        ? { path, content: "bro-omp-ok\n" }
        : {
            language: "js",
            code: `await tool.write({path:${JSON.stringify(path)},content:"bro-omp-ok\\n"});`,
          };
    const delta =
      tool && !hasResult
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_probe",
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { role: "assistant", content: "BRO_PROBE_COMPLETE" };
    const frame = {
      id: "probe",
      object: "chat.completion.chunk",
      created: 1,
      model: "bro-fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    const finish = {
      ...frame,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: tool && !hasResult ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    return new Response(
      `data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const host = createHost(root, "probe-token");
try {
  host.store.saveConnection(
    {
      id: "fixture",
      name: "Local test fixture",
      kind: "api",
      provider: "bro-fixture",
      model: "bro-fixture",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      api: "openai-completions",
      contextWindow: 128000,
      maxTokens: 16000,
      reasoning: false,
      imageInput: true,
    },
    "local-fixture-key",
  );
  const s = host.store.createSession({ connectionId: "fixture" });
  const input = host.store.enqueue(
    s.id,
    "Write proof.txt with bro-omp-ok and report completion.",
    { kind: "gui" },
  );
  host.runtimes.wake(s.id);
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const current = host.store.input(input.id)!,
      state = host.store.session(s.id)!;
    if (
      ["failed", "interrupted"].includes(current.status) ||
      state.status === "error"
    )
      throw new Error(current.error || state.error || current.status);
    if (current.status === "completed") break;
    await Bun.sleep(100);
  }
  if (host.store.input(input.id)?.status !== "completed")
    throw new Error("Probe timeout");
  if (!existsSync(join(root, "workspaces", "proof.txt")))
    throw new Error("Real write tool did not produce the file");
  if (
    !readFileSync(join(root, "workspaces", "proof.txt"), "utf8").includes(
      "bro-omp-ok",
    )
  )
    throw new Error("Unexpected file contents");
  const before = await host.runtimes.history(s.id);
  await host.runtimes.release(s.id);
  const after = await host.runtimes.history(s.id);
  if (
    before.length !== after.length ||
    !after.some((m: any) => m.role === "toolResult")
  )
    throw new Error("History did not survive process shutdown");
  console.log(
    JSON.stringify({
      passed: true,
      root,
      requests,
      messages: after.length,
      note: "Real OMP tools with deterministic local provider; not real model authentication.",
    }),
  );
} catch (error) {
  console.error(error);
  console.error("Probe data and logs:", root);
  process.exitCode = 1;
} finally {
  await host.close();
  await provider.stop(true);
}
