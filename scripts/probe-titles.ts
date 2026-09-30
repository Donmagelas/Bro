import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRoot } from "../packages/platform/paths";
import { createHost } from "../apps/host/server";

const root = mkdtempSync(join(tmpdir(), "bro-titles-"));
prepareRoot(root);
const titles: any[] = [];
const chats: any[] = [];
const releases: (() => void)[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as any;
    const naming = body.messages.some(
      (m: any) =>
        ["system", "developer"].includes(m.role) &&
        JSON.stringify(m.content).includes("<title>"),
    );
    if (naming) {
      titles.push(body);
      assert.equal(body.model, "fixture");
      assert.equal(body.tools?.length || 0, 0);
      assert.equal(req.headers.get("authorization"), "Bearer fixture");
      if (!JSON.stringify(body.messages).includes("命名失败"))
        await new Promise<void>((resolve) => releases.push(resolve));
      else
        return Response.json(
          {
            error: {
              message: "Title unavailable",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        );
    } else chats.push(body);
    const frame = {
      id: "title-probe",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: naming ? "<title>修复登录跳转</title>" : "回复已完成",
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
const completedTitles: (string | null)[] = [];
const completeTitle = host.store.completeTitle.bind(host.store);
host.store.completeTitle = (id, inputId, title) => {
  completedTitles.push(title);
  return completeTitle(id, inputId, title);
};
async function api(path: string, body: any, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${host.server.port}${path}`, {
    method,
    headers: {
      Authorization: "Bearer probe",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as any;
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
async function until(condition: () => boolean) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 45000) throw new Error("Title probe timed out");
    await Bun.sleep(25);
  }
}
async function send(id: string, text: string) {
  return api(`/sessions/${id}/messages`, { text });
}
try {
  host.store.saveConnection(
    {
      id: "fixture",
      name: "Title fixture",
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
  const session = await api("/sessions", { connectionId: "fixture" });
  const first = await send(
    session.id,
    "帮我修复登录后的跳转问题，顺便检查首页按钮",
  );
  assert.equal(
    host.store.session(session.id)?.title,
    "帮我修复登录后的跳转问题，顺便检查首页按钮",
  );
  await until(
    () =>
      titles.length === 1 && host.store.input(first.id)?.status === "completed",
  );
  // The model reply completes while the title request is still deliberately blocked.
  assert.ok(host.store.pendingTitle(session.id));
  releases.shift()!();
  await until(() => host.store.session(session.id)?.title === "修复登录跳转");
  const later = await send(session.id, "继续检查退出登录功能");
  await until(() => host.store.input(later.id)?.status === "completed");
  assert.equal(titles.length, 1);
  assert.equal(host.store.session(session.id)?.title, "修复登录跳转");
  const history = await host.runtimes.history(session.id);
  assert.ok(!JSON.stringify(history).includes("<title>"));
  assert.equal(chats.length, 2);
  assert.ok(!JSON.stringify(chats).includes("<title>"));
  await host.runtimes.release(session.id);
  assert.equal(host.store.session(session.id)?.title, "修复登录跳转");
  const resumed = await send(session.id, "恢复会话后再检查一次");
  await until(() => host.store.input(resumed.id)?.status === "completed");
  assert.equal(titles.length, 1);

  const manual = await api("/sessions", { connectionId: "fixture" });
  const manualInput = await send(manual.id, "请检查登录流程中的报错原因");
  await until(
    () =>
      titles.length === 2 &&
      host.store.input(manualInput.id)?.status === "completed",
  );
  await api(`/sessions/${manual.id}`, { title: "手动保留的名称" }, "PATCH");
  releases.shift()!();
  // Observe the actual late semantic result, not an aborted naming request.
  await until(() => completedTitles.length === 2);
  assert.equal(completedTitles[1], "修复登录跳转");
  assert.equal(host.store.session(manual.id)?.title, "手动保留的名称");

  const failure = await api("/sessions", { connectionId: "fixture" });
  const failedTitleInput = await send(
    failure.id,
    "测试命名失败时仍能正常回答用户",
  );
  await until(
    () =>
      titles.length === 3 &&
      !host.store.pendingTitle(failure.id) &&
      host.store.input(failedTitleInput.id)?.status === "completed",
  );
  assert.equal(
    host.store.session(failure.id)?.title,
    "测试命名失败时仍能正常回答用户",
  );
  assert.equal(host.store.session(failure.id)?.error, null);
  console.log(
    JSON.stringify(
      {
        passed: true,
        root,
        titleRequests: titles.length,
        chatRequests: chats.length,
        proofs: [
          "first-send fallback appears before the runtime starts",
          "real OMP naming uses the selected API connection without tools",
          "reply completes while naming is blocked",
          "semantic title applies once and remains after worker restart",
          "manual rename survives late completion",
          "title provider failure preserves fallback and normal reply",
          "naming requests and responses do not enter chat history",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  releases.splice(0).forEach((release) => release());
  await host.close();
  await provider.stop(true);
}
