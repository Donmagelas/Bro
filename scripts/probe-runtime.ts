import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
let childGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let childObserved: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let waitingTool: ReturnType<typeof Promise.withResolvers<void>> | undefined;
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
    if (prompt.includes("BRO_SUPPLEMENT"))
      text = "BRO_WITH_SUPPLEMENT: BRO_CHILD_COMPLETE";
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
    } else if (prompt.includes("BRO_SEND_FILE")) {
      if (!prompt.includes("当前输入渠道：飞书机器人"))
        throw new Error("Feishu source context missing");
      if (!toolCount)
        call = { name: "bro_send_file", args: { path: "outgoing.md" } };
      else {
        if (!JSON.stringify(messages).includes("fixture-file-message"))
          throw new Error("File receipt missing from tool result");
        text = "BRO_FILE_SENT";
      }
    } else if (prompt.includes("BRO_ATTACHMENT")) {
      if (!toolCount)
        call = {
          name: "read",
          args: { path: join(root, "attachments", "probe.md") },
        };
      else text = "BRO_ATTACHMENT_READ";
      if (
        !prompt.includes(`附件文件：${join(root, "attachments", "probe.md")}`)
      )
        throw new Error("Attachment path did not reach the model");
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
    } else if (prompt.includes("BRO_EXTERNAL")) {
      if (toolCount === 0) call = { name: "bro_wait", args: { seconds: 1 } };
      else if (toolCount === 1)
        call = {
          name: "read",
          args: { path: join(root, "workspaces", "external.txt") },
        };
      else {
        if (!JSON.stringify(messages).includes("EXTERNAL_ACTUAL_RESULT"))
          throw new Error("No external result was read");
        text = "BRO_EXTERNAL_COMPLETE: EXTERNAL_ACTUAL_RESULT";
      }
    } else if (prompt.includes("BRO_DELEGATE")) {
      if (!toolCount)
        call = {
          name: "bro_send_session",
          args: {
            sessionId: prompt.match(/BRO_DELEGATE ([a-f0-9-]+)/)?.[1],
            text: prompt.includes("BRO_TARGET_WAIT")
              ? "BRO_WAIT"
              : prompt.match(/BRO_NEST ([a-f0-9-]+)/)
                ? `BRO_DELEGATE ${prompt.match(/BRO_NEST ([a-f0-9-]+)/)![1]}`
                : "BRO_CHILD write proof",
            waitForResult: !prompt.includes("BRO_SEND_ONLY"),
          },
        };
      else {
        const result = JSON.stringify(
          messages.slice(lastIndex).filter((m: any) => m.role === "tool"),
        );
        if (result.includes("BRO_CHILD_COMPLETE"))
          text = "BRO_CORRELATED_RESULT: BRO_CHILD_COMPLETE";
        else if (result.includes("queued")) text = "BRO_SENT_ONLY";
        else text = "BRO_CHILD_FAILED: " + result;
      }
    } else if (prompt.includes("BRO_WAIT")) {
      if (!toolCount) call = { name: "bro_wait", args: { seconds: 30 } };
      else text = "BRO_WAIT_COMPLETE";
    } else if (prompt.includes("BRO_CHILD")) {
      if (!toolCount)
        call = {
          name: "write",
          args: {
            path: join(root, "workspaces", "child.txt"),
            content: "CHILD_EXECUTED",
          },
        };
      else {
        childObserved?.resolve();
        await childGate?.promise;
        text = "BRO_CHILD_COMPLETE";
      }
    } else if (prompt.includes("交办结果")) text = "BRO_CORRELATED_RESULT";
    const calls = call ? [call] : [];
    if (
      call?.name === "bro_send_session" &&
      prompt.includes("BRO_SERIAL_PROOF")
    )
      calls.push({
        name: "write",
        args: {
          path: join(root, "workspaces", "source-after-wait.txt"),
          content: "SOURCE_RESUMED",
        },
      });
    const delta = call
      ? {
          role: "assistant",
          tool_calls: calls.map((c, index) => ({
            index,
            id: `call_${requests}_${index}`,
            type: "function",
            function: {
              name: c.name,
              arguments: JSON.stringify(c.args),
            },
          })),
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
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
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
  const attachmentPath = join(root, "attachments", "probe.md");
  writeFileSync(attachmentPath, "EXACT_ATTACHMENT_CONTENT");
  const withFile = host.store.enqueue(
    source.id,
    "BRO_ATTACHMENT",
    { kind: "gui" },
    {
      attachments: [
        { path: attachmentPath, name: "probe.md", mimeType: "text/markdown" },
      ],
    },
  );
  host.runtimes.wake(source.id);
  await wait(withFile.id);
  if (
    !JSON.stringify(await host.runtimes.history(source.id)).includes(
      "EXACT_ATTACHMENT_CONTENT",
    )
  )
    throw new Error("Runtime did not read the supplied attachment");
  const missingFile = host.store.enqueue(
    source.id,
    "BRO_ATTACHMENT",
    { kind: "gui" },
    {
      attachments: [
        { path: attachmentPath, name: "probe.md", mimeType: "text/markdown" },
      ],
    },
  );
  rmSync(attachmentPath);
  const requestsBeforeMissingFile = requests;
  host.runtimes.wake(source.id);
  await wait(missingFile.id).catch(() => {});
  const rejected = host.store.input(missingFile.id)!;
  if (
    rejected.status !== "failed" ||
    !rejected.error?.includes("指定附件") ||
    requests !== requestsBeforeMissingFile
  )
    throw new Error(
      "Missing attachment was not rejected before model execution",
    );
  childGate = Promise.withResolvers<void>();
  childObserved = Promise.withResolvers<void>();
  const original = host.store.enqueue(
    source.id,
    `BRO_DELEGATE ${target.id} BRO_SERIAL_PROOF`,
    {
      kind: "feishu",
      connectionId: "fixture",
      senderId: "owner",
      chatId: "dm",
      messageId: "original",
    },
  );
  host.runtimes.wake(source.id);
  await bounded(childObserved.promise, "same-directory child result");
  const later = host.store.enqueue(source.id, "BRO_PLAIN", { kind: "gui" });
  host.runtimes.wake(source.id);
  if (
    host.store.input(original.id)?.status !== "running" ||
    host.store.input(later.id)?.status !== "queued" ||
    host.store.db.query("SELECT id FROM outbox WHERE id=?").get(original.id)
  )
    throw new Error("Waiting source replied early or consumed a later input");
  if (
    await Bun.file(join(root, "workspaces", "source-after-wait.txt")).exists()
  )
    throw new Error(
      "Source tool ran concurrently while its directory was yielded",
    );
  childGate.resolve();
  await wait(original.id);
  await wait(later.id);
  childGate = undefined;
  if (
    readFileSync(join(root, "workspaces", "source-after-wait.txt"), "utf8") !==
    "SOURCE_RESUMED"
  )
    throw new Error(
      "Source tool did not resume after reacquiring its directory",
    );
  const reply = host.store.db
    .query("SELECT text FROM outbox WHERE id=?")
    .get(original.id) as any;
  if (
    !reply?.text.includes("BRO_CHILD_COMPLETE") ||
    host.store.inputs(source.id).some((i) => i.id.startsWith("result:"))
  )
    throw new Error(
      "Inline result missing, duplicated, or lost original reply correlation",
    );
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
  // Send-only must finish before the target result, without a later notification.
  childGate = Promise.withResolvers<void>();
  childObserved = Promise.withResolvers<void>();
  await send(source.id, `BRO_DELEGATE ${target.id} BRO_SEND_ONLY`);
  await bounded(childObserved.promise, "send-only child result");
  childGate.resolve();
  await wait(host.store.inputs(target.id).at(-1)!.id);
  childGate = undefined;
  // Steer stays accepted during the wait and reaches the next safe tool boundary.
  childGate = Promise.withResolvers<void>();
  childObserved = Promise.withResolvers<void>();
  const steered = host.store.enqueue(source.id, `BRO_DELEGATE ${target.id}`, {
    kind: "gui",
  });
  host.runtimes.wake(source.id);
  await bounded(childObserved.promise, "steered child result");
  await host.runtimes.steer(source.id, {
    text: "BRO_SUPPLEMENT",
    source: { kind: "gui" },
    createdAt: Date.now(),
  });
  childGate.resolve();
  await wait(steered.id);
  childGate = undefined;
  if (
    !JSON.stringify(await host.runtimes.history(source.id)).includes(
      "BRO_WITH_SUPPLEMENT",
    )
  )
    throw new Error("Steer was lost during delegation wait");
  // Cancelling the source cancels its running child and the cancellable timer.
  const hostCall = host.runtimes.hostCall!;
  waitingTool = Promise.withResolvers<void>();
  host.runtimes.hostCall = async (...args) => {
    if (args[2] === "bro_wait") waitingTool?.resolve();
    return hostCall(...args);
  };
  const stopped = host.store.enqueue(
    source.id,
    `BRO_DELEGATE ${target.id} BRO_TARGET_WAIT`,
    { kind: "gui" },
  );
  host.runtimes.wake(source.id);
  await bounded(waitingTool.promise, "child starts wait");
  await host.runtimes.stop(source.id);
  const stopStart = Date.now();
  while (
    host.store.input(stopped.id)?.status === "running" &&
    Date.now() - stopStart < 5000
  )
    await Bun.sleep(50);
  if (
    host.store.input(stopped.id)?.status !== "cancelled" ||
    host.store.inputs(target.id).at(-1)?.status !== "cancelled"
  )
    throw new Error("Source stop did not cancel its waiting child");
  // The child can itself delegate in the same directory without deadlocking.
  const nested = host.store.createSession({
    title: "Nested",
    connectionId: "fixture",
  });
  await send(source.id, `BRO_DELEGATE ${target.id} BRO_NEST ${nested.id}`);
  if (
    host.store
      .delegations()
      .slice(-2)
      .some((d) => d.status !== "completed")
  )
    throw new Error("Nested same-directory delegation did not finish");
  // Cancelling a queued child must leave unrelated target work alone.
  waitingTool = Promise.withResolvers<void>();
  const unrelated = host.store.enqueue(target.id, "BRO_WAIT", { kind: "gui" });
  host.runtimes.wake(target.id);
  await bounded(waitingTool.promise, "unrelated target wait");
  // Use another directory so the source can enqueue while target holds its lock.
  const independent = host.store.createSession({
    title: "Independent",
    connectionId: "fixture",
    cwd: root,
  });
  const queueStop = host.store.enqueue(
    independent.id,
    `BRO_DELEGATE ${target.id}`,
    { kind: "gui" },
  );
  host.runtimes.wake(independent.id);
  const queuedStart = Date.now();
  while (
    !host.store.delegations().some((d) => d.originInputId === queueStop.id) &&
    Date.now() - queuedStart < 30000
  )
    await Bun.sleep(50);
  const queuedChild = host.store
    .delegations()
    .find((d) => d.originInputId === queueStop.id);
  if (!queuedChild || queuedChild.status !== "queued")
    throw new Error("Child wasn't queued behind unrelated task");
  await host.runtimes.stop(independent.id);
  if (
    host.store.input(unrelated.id)?.status !== "running" ||
    host.store.input(queuedChild.targetInputId)?.status !== "cancelled"
  )
    throw new Error(
      "Stopping queued delegation interrupted unrelated target work",
    );
  await host.runtimes.stop(target.id);
  // A delayed external result is read before the same source input completes.
  waitingTool = Promise.withResolvers<void>();
  const external = host.store.enqueue(source.id, "BRO_EXTERNAL", {
    kind: "gui",
  });
  host.runtimes.wake(source.id);
  await bounded(waitingTool.promise, "external result wait");
  if (host.store.input(external.id)?.status !== "running")
    throw new Error("External wait ended early");
  writeFileSync(
    join(root, "workspaces", "external.txt"),
    "EXTERNAL_ACTUAL_RESULT",
  );
  await wait(external.id);
  host.runtimes.hostCall = hostCall;
  // Initialization failures return to the original turn instead of waiting forever.
  const broken = host.store.createSession({
    title: "Broken connection",
    connectionId: "missing",
  });
  await send(source.id, `BRO_DELEGATE ${broken.id}`);
  if (
    !JSON.stringify(await host.runtimes.history(source.id)).includes(
      "BRO_CHILD_FAILED",
    )
  )
    throw new Error("Target initialization failure did not reach source");
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
  // Real OMP -> host -> outbox, with only Feishu transport stubbed.
  const uploaded: any[] = [],
    delivered: any[] = [];
  host.feishu.status = { configured: true, connected: true, appId: "fixture" };
  (host.feishu as any).client = {
    im: {
      file: {
        create: async (payload: any) => {
          uploaded.push(payload);
          return { file_key: "fixture-key" };
        },
      },
      message: {
        reply: async (payload: any) => {
          delivered.push(payload);
          return { code: 0, data: { message_id: "fixture-file-message" } };
        },
      },
    },
  };
  writeFileSync(
    join(root, "workspaces", "outgoing.md"),
    "# EXACT_OUTGOING_MARKDOWN\n中文\n",
  );
  const outgoing = host.store.enqueue(source.id, "BRO_SEND_FILE", {
    kind: "feishu",
    connectionId: "fixture",
    messageId: "file-request",
    chatId: "dm",
  });
  host.runtimes.wake(source.id);
  await wait(outgoing.id);
  await host.feishu.flush();
  if (
    uploaded.length !== 1 ||
    uploaded[0].data.file.toString() !== "# EXACT_OUTGOING_MARKDOWN\n中文\n"
  )
    throw new Error("Outgoing bytes differ");
  const fileMessages = delivered.filter((x) => x.data.msg_type === "file");
  if (
    fileMessages.length !== 1 ||
    fileMessages[0].path.message_id !== "file-request"
  )
    throw new Error("File not correlated to original chat message");
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
        "native Feishu file tool delivers exact Markdown bytes to the original request and receives a message ID",
        "exact attachment reaches model and read tool; removed attachment rejected before model execution",
        "same-directory inline delegation + one correlated reply, queued later input, send-only, steer, nested delegation",
        "stop running/queued child without stopping unrelated work; target initialization failure returns",
        "cancellable external wait + read actual delayed result before replying",
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
  childGate?.resolve();
  await host.close();
  await provider.stop(true);
}
