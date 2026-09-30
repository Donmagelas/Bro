import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareRoot } from "../packages/platform/paths";
import { createHost } from "../apps/host/server";

const root = mkdtempSync(join(tmpdir(), "bro-runtime-probe-"));
prepareRoot(root);
let requests = 0;
let lastTools: string[] = [];
let lastSystem = "",
  judgments = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method === "GET")
      return new Response(
        `<input id="x"><button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#x').value">OK</button><div id="result"></div>`,
        { headers: { "Content-Type": "text/html" } },
      );
    const body = (await req.json()) as any;
    if (new URL(req.url).pathname === "/v1/systemone") {
      judgments++;
      return Response.json({
        model: "laya-fixture",
        answers: Object.fromEntries(
          body.state.candidates.map((c: any) => [
            c.id,
            {
              type: "noul",
              noul: c.text.startsWith("bro-probe:") ? 0.95 : 0.05,
            },
          ]),
        ),
        usage: { input_tokens: 100, output_tokens: 1 },
      });
    }
    lastSystem = JSON.stringify(
      body.messages.filter((m: any) =>
        ["system", "developer"].includes(m.role),
      ),
    );
    requests++;
    lastTools = (body.tools || []).map((t: any) => t.function.name);
    const messages = body.messages as any[],
      lastIndex = messages.findLastIndex((m) => m.role === "user");
    const prompt =
      typeof messages[lastIndex]?.content === "string"
        ? messages[lastIndex].content
        : (messages[lastIndex]?.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");

    const toolCount = messages
      .slice(lastIndex)
      .filter((m) => m.role === "tool").length;
    let call: any,
      text = "BRO_PLAIN_COMPLETE";
    if (prompt.includes("交办结果")) text = "BRO_CORRELATED_RESULT";
    else if (prompt.includes("BRO_BROWSER")) {
      if (!toolCount)
        call = {
          name: "eval",
          args: {
            language: "js",
            code: `const tab=await browser.open({name:"probe",url:${JSON.stringify(`http://127.0.0.1:${provider.port}/page`)},app:{path:${JSON.stringify(process.env.BRO_PROBE_BROWSER)}},headed:false});await tab.fill("#x","BRO_BROWSER_VALUE");await tab.click("#submit");console.log(await tab.text("#result"));await tab.close();`,
          },
        };
      else text = "BRO_BROWSER_COMPLETE";
    } else if (prompt.includes("BRO_RESOURCE")) {
      if (toolCount === 0) call = { name: "bro_fixture_greet", args: {} };
      else if (toolCount === 1)
        call = {
          name: "eval",
          args: {
            language: "js",
            code: 'console.log(await tool.mcp__fixture_echo({text:"hello"}));',
          },
        };
      else if (toolCount === 2)
        call = { name: "read", args: { path: "skill://bro-probe" } };
      else text = "BRO_RESOURCE_COMPLETE";
    } else if (prompt.includes("BRO_DELEGATE")) {
      if (!toolCount)
        call = {
          name: "bro_send_session",
          args: {
            sessionId: prompt.match(/BRO_DELEGATE ([a-f0-9-]+)/)?.[1],
            text: "BRO_CHILD write proof",
          },
        };
      else text = "交办已接收；来源会话可以继续聊天。";
    } else if (prompt.includes("BRO_CHILD")) {
      if (!toolCount)
        call = {
          name: "write",
          args: {
            path: join(root, "workspaces", "child.txt"),
            content: "CHILD_EXECUTED",
          },
        };
      else text = "BRO_CHILD_COMPLETE";
    } else if (prompt.includes("交办结果")) text = "BRO_CORRELATED_RESULT";
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${requests}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        }
      : { role: "assistant", content: text };
    const frame = {
      id: `f${requests}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const host = createHost(root, "probe");
async function api(path: string, body: any, method = "POST") {
  const r = await fetch(`http://127.0.0.1:${host.server.port}${path}`, {
    method,
    headers: {
      Authorization: "Bearer probe",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as any;
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function wait(id: string) {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const input = host.store.input(id);
    if (input?.status === "completed") return;
    if (["failed", "interrupted"].includes(input?.status || ""))
      throw new Error(input?.error);
    const s = input && host.store.session(input.sessionId);
    if (s?.status === "error") throw new Error(s.error || "Runtime failed");
    await Bun.sleep(100);
  }
  throw new Error("Timeout");
}
async function send(id: string, text: string) {
  const input = host.store.enqueue(id, text, { kind: "gui" });
  host.runtimes.wake(id);
  await wait(input.id);
  return input;
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
      imageInput: true,
    },
    "fixture-key",
  );
  await api("/resources", {
    kind: "plugin",
    source: resolve("tests/fixtures/plugin"),
  });
  await api("/resources", {
    kind: "skill",
    source: resolve("tests/fixtures/skills"),
  });
  await api("/resources", {
    kind: "mcp",
    name: "fixture",
    config: {
      command: process.execPath,
      args: [resolve("tests/fixtures/mcp.ts")],
    },
  });
  const source = host.store.createSession({
      title: "Runtime probe",
      connectionId: "fixture",
    }),
    target = host.store.createSession({
      title: "Runtime probe",
      connectionId: "fixture",
    });
  await send(source.id, "BRO_RESOURCE");
  const history = JSON.stringify(await host.runtimes.history(source.id));
  for (const proof of ["PLUGIN_EXECUTED", "MCP_EXECUTED", "BRO_SKILL_LOADED"])
    if (!history.includes(proof))
      throw new Error(`Missing real resource result: ${proof}`);
  await send(source.id, `BRO_DELEGATE ${target.id}`);
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const result = host.store
      .inputs(source.id)
      .find((i) => i.id.startsWith("result:"));
    if (result) {
      await wait(result.id);
      break;
    }
    await Bun.sleep(100);
  }
  if (
    readFileSync(join(root, "workspaces", "child.txt"), "utf8") !==
    "CHILD_EXECUTED"
  )
    throw new Error("Child did not execute");
  if (
    !JSON.stringify(await host.runtimes.history(source.id)).includes(
      "BRO_CORRELATED_RESULT",
    )
  )
    throw new Error("Missing return to source");
  const plugin = host.state().resources.find((r) => r.kind === "plugin")!;
  await api("/resources", { id: plugin.id, action: "toggle", enabled: false });
  await send(source.id, "BRO_PLAIN");
  if (lastTools.includes("bro_fixture_greet"))
    throw new Error("Disabled plugin remained callable in provider tool list");
  if (process.env.BRO_PROBE_BROWSER) {
    await send(source.id, "BRO_BROWSER");
    if (
      !(await host.runtimes.history(source.id)).some(
        (m: any) =>
          m.role === "toolResult" &&
          m.toolName === "eval" &&
          !m.isError &&
          m.content.some(
            (c: any) =>
              c.type === "text" &&
              c.text.split("\n").includes("BRO_BROWSER_VALUE"),
          ),
      )
    )
      throw new Error("Browser did not return the entered value");
  }
  const experiment = {
    ...host.store.getSettings().experiments,
    skills: "shadow",
    backend: "laya",
    endpoint: `http://127.0.0.1:${provider.port}`,
    model: "multilingual",
  };
  await api("/settings", { experiments: experiment }, "PATCH");
  await send(source.id, "BRO_EXPERIMENT");
  if (!judgments || !lastSystem.includes("irrelevant-skill-sentinel"))
    throw new Error("Shadow changed the baseline or skipped evaluation");
  await api(
    "/settings",
    { experiments: { ...experiment, skills: "experimental" } },
    "PATCH",
  );
  await send(source.id, "BRO_EXPERIMENT");
  if (lastSystem.includes("irrelevant-skill-sentinel"))
    throw new Error(
      "Experimental Skill choice was not applied to provider context",
    );
  const before = judgments;
  await api(
    "/settings",
    {
      experiments: {
        skills: "normal",
        context: "normal",
        compression: "normal",
      },
    },
    "PATCH",
  );
  await send(source.id, "BRO_NORMAL");
  if (judgments !== before || !lastSystem.includes("irrelevant-skill-sentinel"))
    throw new Error(
      "Normal mode did not restore the original catalog without judgment requests",
    );
  console.log(
    JSON.stringify({
      passed: true,
      root,
      requests,
      judgments,
      browser: !!process.env.BRO_PROBE_BROWSER,
      proofs: [
        "native plugin install + call",
        "native MCP call",
        "explicit Skill read",
        "separate-process cross-session execution + return",
        "disabled plugin removed at next boundary",
        "shadow/experimental/normal Skill selection through real OMP provider hooks",
      ],
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
