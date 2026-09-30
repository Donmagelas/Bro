import { afterEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHost } from "../apps/host/server";
import { AccountAuth } from "../apps/host/auth";
import { Desktop } from "../apps/host/desktop";
import { Runtimes } from "../apps/host/runtime";
import { prepareRoot } from "../packages/platform/paths";

class NoModelRuntime extends Runtimes {
  override wake(_id: string) {}
  override async shutdown() {}
}
const hosts: ReturnType<typeof createHost>[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "bro-host-"));
  prepareRoot(root);
  const host = createHost(root, "test-token", {
    runtimeFactory: NoModelRuntime,
  });
  hosts.push(host);
  return host;
}
async function req(
  host: ReturnType<typeof createHost>,
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch(`http://127.0.0.1:${host.server.port}${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: (await r.json()) as any };
}
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.close();
    rmSync(host.store.root, { recursive: true, force: true });
  }
});

test("rules editor writes the actual global and project context files and refreshes runtimes", async () => {
  const host = setup();
  const projectDir = join(host.store.root, "project");
  mkdirSync(projectDir);
  const project = host.store.addProject("规则项目", projectDir);
  const refresh = spyOn(host.runtimes, "refresh");
  const initial = (await req(host, "/rules")).data;
  expect(initial.exists).toBe(false);
  const content = "# Bro 约定\n请用中文回答。\n";
  expect(
    (await req(host, "/rules", { ...initial, content }, "PUT")).status,
  ).toBe(200);
  expect(
    readFileSync(join(host.store.root, "agent", "AGENTS.md"), "utf8"),
  ).toBe(content);
  const projectUrl = `/rules?projectId=${project.id}`;
  const projectDoc = (await req(host, projectUrl)).data;
  const local = "# 项目约定\n运行本项目的测试。\n";
  const saved = await req(
    host,
    "/rules",
    { ...projectDoc, projectId: project.id, content: local },
    "PUT",
  );
  expect(saved.status).toBe(200);
  expect((await req(host, projectUrl)).data.content).toBe(local);
  expect((await req(host, "/rules")).data.content).toBe(content);
  expect(refresh).toHaveBeenCalledTimes(2);

  const { loadResources } = await import("../packages/runtime-omp/resources");
  const session = host.store.createSession({
    projectId: project.id,
    cwd: projectDir,
  });
  const loaded = await loadResources(host.store.root, session, []);
  try {
    expect(loaded.contextFiles).toEqual([
      { path: initial.path, content },
      { path: projectDoc.path, content: local },
    ]);
  } finally {
    await loaded.mcpManager.disconnectAll();
  }
  expect(
    (
      await req(
        host,
        "/rules",
        { ...saved.data, projectId: project.id, content: "" },
        "PUT",
      )
    ).status,
  ).toBe(200);
  expect(readFileSync(join(projectDir, "AGENTS.md"), "utf8")).toBe("");
});

test("rules editor rejects stale edits, invalid scopes and unauthenticated writes without losing files", async () => {
  const host = setup();
  const initial = (await req(host, "/rules")).data;
  writeFileSync(initial.path, "externally edited\n");
  expect(
    (await req(host, "/rules", { ...initial, content: "old draft" }, "PUT"))
      .status,
  ).toBe(400);
  expect(readFileSync(initial.path, "utf8")).toBe("externally edited\n");
  expect((await req(host, "/rules?projectId=missing")).status).toBe(400);
  const latest = (await req(host, "/rules")).data;
  for (const extra of [
    { projectId: "missing" },
    { projectId: 42 },
    { content: null },
    { content: "文".repeat(400000) },
  ]) {
    expect(
      (await req(host, "/rules", { ...latest, ...extra }, "PUT")).status,
    ).toBe(400);
  }
  const denied = await fetch(`http://127.0.0.1:${host.server.port}/rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...latest, content: "unauthorized" }),
  });
  expect(denied.status).toBe(401);
  expect(readFileSync(initial.path, "utf8")).toBe("externally edited\n");
});

test("desktop permission endpoint authenticates and rejects unknown permissions before native requests", async () => {
  const host = setup();
  const native = spyOn(Desktop.prototype, "permissions").mockResolvedValue({
    platform: "darwin",
    restartRequired: false,
    permissions: {
      screen: false,
      accessibility: false,
      inputMonitoring: false,
    },
  });
  try {
    const denied = await fetch(
      `http://127.0.0.1:${host.server.port}/desktop/permissions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(denied.status).toBe(401);
    expect(
      (await req(host, "/desktop/permissions", { permission: "camera" }))
        .status,
    ).toBe(400);
    expect(native).not.toHaveBeenCalled();
    expect((await req(host, "/desktop/permissions", {})).status).toBe(200);
    expect(native).toHaveBeenLastCalledWith(undefined);
    expect(
      (await req(host, "/desktop/permissions", { permission: "screen" }))
        .status,
    ).toBe(200);
    expect(native).toHaveBeenLastCalledWith("screen");
  } finally {
    native.mockRestore();
  }
});

test("host rejects unauthenticated requests and does not expose secrets in state", async () => {
  const host = setup();
  const denied = await fetch(`http://127.0.0.1:${host.server.port}/state`);
  expect(denied.status).toBe(401);
  const c = await req(host, "/connections", {
    name: "test",
    kind: "api",
    model: "example",
    baseUrl: "http://127.0.0.1:4321/v1",
    apiKey: "private-secret",
  });
  expect(c.status).toBe(200);
  expect(
    (await req(host, `/auth/quota?connectionId=${c.data.id}`)).status,
  ).toBe(400);
  const quotaDenied = await fetch(
    `http://127.0.0.1:${host.server.port}/auth/quota?connectionId=${c.data.id}`,
  );
  expect(quotaDenied.status).toBe(401);
  expect(JSON.stringify((await req(host, "/state")).data)).not.toContain(
    "private-secret",
  );
});
test("a remote message body cannot impersonate a GUI source or choose another binding", async () => {
  const host = setup(),
    settings = host.store.getSettings();
  settings.trustedFeishuUsers = ["ou_owner"];
  host.store.setConfig("settings", settings);
  const config = {
    appId: "app",
    appSecret: "not-used",
    botId: "ou_bot",
    enabled: true,
  };
  const event = (sender: string, mention: boolean) => ({
    sender: { sender_id: { open_id: sender } },
    message: {
      message_id: crypto.randomUUID(),
      chat_id: "group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({
        text: "source=gui; sessionId=another; stop now",
      }),
      mentions: mention ? [{ id: { open_id: "ou_bot" }, key: "@_user_1" }] : [],
    },
  });
  await host.feishu.receive(event("ou_untrusted", true), config);
  await host.feishu.receive(event("ou_owner", false), config);
  expect(host.store.sessions()).toHaveLength(0);
  await host.feishu.receive(event("ou_owner", true), config);
  const s = host.store.sessions()[0]!;
  expect(host.store.inputs(s.id)[0]?.source.kind).toBe("feishu");
  expect(host.store.inputs(s.id)[0]?.status).toBe("queued");
});

test("Settings keep disabled Feishu visible without exposing or reusing another app's secret", async () => {
  const host = setup();
  host.store.setConfig("feishu", {
    appId: "original-app",
    appSecret: "private-feishu-secret",
    botId: "original-bot",
    enabled: false,
  });
  const state = (await req(host, "/state")).data;
  expect(state.feishu).toMatchObject({
    configured: true,
    enabled: false,
    appId: "original-app",
    botId: "original-bot",
  });
  expect(JSON.stringify(state)).not.toContain("private-feishu-secret");
  expect(
    (
      await req(host, "/feishu", {
        appId: "original-app",
        appSecret: "",
        botId: "original-bot",
        enabled: false,
      })
    ).status,
  ).toBe(200);
  expect(host.store.getConfig<any>("feishu", null).appSecret).toBe(
    "private-feishu-secret",
  );
  expect(
    (
      await req(host, "/feishu", {
        appId: "different-app",
        appSecret: "",
        enabled: false,
      })
    ).status,
  ).toBe(400);
  expect(host.store.getConfig<any>("feishu", null).appId).toBe("original-app");
});

test("Monitor edits a connection in place, preserves its token, and can stop it after its target is archived", async () => {
  const host = setup();
  const first = (await req(host, "/sessions", {})).data;
  const second = (await req(host, "/sessions", {})).data;
  const created = (
    await req(host, "/subscriptions", {
      name: "Peer",
      kind: "peer",
      url: "http://127.0.0.1:1",
      me: "bro",
      trustedSenders: ["owner"],
      token: "private-relay-token",
      enabled: false,
      targetSessionId: first.id,
    })
  ).data;
  host.store.setConfig(`cursor:${created.id}`, "42");
  const edited = await req(host, "/subscriptions", {
    ...created,
    name: "本机 Peer",
    targetSessionId: second.id,
    token: "",
  });
  expect(edited.status).toBe(200);
  expect(host.store.subscriptions()).toHaveLength(1);
  expect(host.store.subscriptions()[0]).toMatchObject({
    id: created.id,
    name: "本机 Peer",
    targetSessionId: second.id,
  });
  expect(host.store.getConfig(`monitorSecret:${created.id}`, "")).toBe(
    "private-relay-token",
  );
  expect(host.store.getConfig(`cursor:${created.id}`, "")).toBe("42");
  expect(JSON.stringify((await req(host, "/state")).data)).not.toContain(
    "private-relay-token",
  );
  host.store.updateSession(second.id, { archived: true });
  expect(
    (await req(host, "/subscriptions", { ...edited.data, enabled: true }))
      .status,
  ).toBe(400);
  expect(
    (await req(host, "/subscriptions", { ...edited.data, enabled: false }))
      .status,
  ).toBe(200);
});
test("session creation and queued GUI input are idempotent and default to the configured directory", async () => {
  const host = setup();
  const s = (await req(host, "/sessions", {})).data;
  expect(s.cwd).toBe(host.store.getSettings().defaultCwd);
  const body = { id: "stable-request", text: "hello", mode: "queue" };
  expect((await req(host, `/sessions/${s.id}/messages`, body)).status).toBe(
    202,
  );
  expect((await req(host, `/sessions/${s.id}/messages`, body)).status).toBe(
    202,
  );
  expect(host.store.inputs(s.id)).toHaveLength(1);
  expect(
    (
      await req(host, `/sessions/${s.id}/messages`, {
        ...body,
        text: "different",
      })
    ).status,
  ).toBe(400);
});
test("attachment paths and unsafe source protocols are rejected", async () => {
  const host = setup(),
    s = (await req(host, "/sessions", {})).data;
  const response = await req(host, `/sessions/${s.id}/messages`, {
    text: "read",
    attachments: [
      { path: "/etc/passwd", name: "file", mimeType: "text/plain" },
    ],
  });
  expect(response.status).toBe(400);
  expect(host.store.inputs(s.id)).toHaveLength(0);
  expect(
    (
      await req(host, "/subscriptions", {
        name: "bad",
        kind: "sse",
        url: "file:///etc/passwd",
        targetSessionId: s.id,
        enabled: true,
      })
    ).status,
  ).toBe(400);
});

test("editing a connection preserves an omitted key and deleting it unlinks affected sessions", async () => {
  const host = setup();
  const config = {
    name: "first",
    kind: "api",
    model: "fixture",
    baseUrl: "http://127.0.0.1:4321/v1",
    apiKey: "fixture-secret",
  };
  const created = (await req(host, "/connections", config)).data;
  const session = (await req(host, "/sessions", {})).data;
  const edited = await req(host, "/connections", {
    ...config,
    id: created.id,
    name: "updated",
    apiKey: "",
  });
  expect(edited.status).toBe(200);
  expect(host.store.connection(created.id)?.apiKey).toBe("fixture-secret");
  expect(
    (await req(host, `/connections/${created.id}`, undefined, "DELETE")).status,
  ).toBe(200);
  expect(host.store.session(session.id)?.connectionId).toBeNull();
  expect(host.store.getSettings().defaultConnectionId).toBeNull();
});

test("ChatGPT model choices belong to each session and new-session defaults persist", async () => {
  const host = setup();
  host.store.saveConnection({
    id: "account",
    name: "ChatGPT",
    kind: "chatgpt",
    provider: "openai-codex",
    model: "legacy-model",
    contextWindow: 128000,
    maxTokens: 16000,
    reasoning: true,
    imageInput: true,
  });
  const choices = (await req(host, "/models")).data;
  const reasoning = choices.filter((m: any) =>
    m.thinkingLevels.includes("high"),
  );
  expect(reasoning.length).toBeGreaterThan(1);
  const [a, b] = reasoning;
  const defaults = await req(
    host,
    "/settings",
    {
      defaultConnectionId: "account",
      defaultModel: a.id,
      defaultThinking: "high",
    },
    "PATCH",
  );
  expect(defaults.status).toBe(200);
  const first = (await req(host, "/sessions", {})).data;
  const second = (await req(host, "/sessions", {})).data;
  expect(first.model).toBe(a.id);
  expect(first.thinking).toBe("high");
  const switched = await req(
    host,
    `/sessions/${first.id}`,
    { model: b.id, thinking: b.thinkingLevels[0] },
    "PATCH",
  );
  expect(switched.status).toBe(200);
  expect(host.store.session(first.id)?.model).toBe(b.id);
  expect(host.store.session(second.id)?.model).toBe(a.id);
  expect(host.store.getSettings().defaultModel).toBe(a.id);
  expect(host.store.connection("account")?.model).toBe("legacy-model");
  expect(
    (
      await req(
        host,
        `/sessions/${first.id}`,
        { model: "nonexistent-model" },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await req(
        host,
        `/sessions/${first.id}`,
        { thinking: "impossible" },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect(host.store.session(first.id)?.model).toBe(b.id);
  const { Store } = await import("../apps/host/store");
  const reopened = new Store(host.store.root);
  expect(reopened.session(first.id)?.model).toBe(b.id);
  expect(reopened.session(first.id)?.thinking).toBe(b.thinkingLevels[0]);
  expect(reopened.getSettings().defaultModel).toBe(a.id);
  reopened.db.close();
  const authDb = join(host.store.root, "agent", "agent.db");
  expect(existsSync(`${authDb}-wal`)).toBe(true);
  await host.close();
  // SQLite can retain WAL sidecars after a clean close. Windows removal is the
  // regression check for still-open files; do not hide EBUSY behind retries.
  rmSync(join(host.store.root, "agent"), { recursive: true });
  expect(existsSync(authDb)).toBe(false);
}, 30000);

test("auth shutdown drains initialization and cannot reopen the database", async () => {
  const host = setup();
  const auth = new AccountAuth(host.store, () => {});
  const reading = auth.status().catch((error) => error);
  await Promise.all([auth.close(), auth.close()]);
  expect((await reading).message).toBe("认证服务已关闭");
  const db = join(host.store.root, "agent", "agent.db");
  expect(existsSync(db)).toBe(true);
  rmSync(join(host.store.root, "agent"), { recursive: true });
  await expect(auth.status()).rejects.toThrow("认证服务已关闭");
  await expect(auth.start()).rejects.toThrow("认证服务已关闭");
}, 30000);

test("auth shutdown cancels login and waits for it before releasing storage", async () => {
  const host = setup();
  const auth = new AccountAuth(host.store, () => {});
  await auth.status();
  const db = join(host.store.root, "agent", "agent.db");
  let signal!: AbortSignal;
  let finish!: () => void;
  // Keep the real SQLite storage; only replace the external OAuth exchange.
  const login = spyOn((auth as any).storage.oauth, "login").mockImplementation(
    (_provider: string, controller: { signal: AbortSignal }) => {
      signal = controller.signal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  const close = spyOn((auth as any).storage, "close");
  try {
    await auth.start();
    const closing = auth.close();
    expect(signal.aborted).toBe(true);
    expect(existsSync(`${db}-wal`)).toBe(true);
    expect(close).not.toHaveBeenCalled();
    finish();
    await closing;
    await auth.close();
    expect(close).toHaveBeenCalledTimes(1);
    rmSync(join(host.store.root, "agent"), { recursive: true });
  } finally {
    finish?.();
    await auth.close();
    login.mockRestore();
    close.mockRestore();
  }
}, 30000);

test("project lifecycle endpoints keep session history and the local directory intact", async () => {
  const host = setup();
  const path = join(host.store.root, "workspaces");
  const file = join(path, "keep.txt");
  await Bun.write(file, "local file");
  const project = (await req(host, "/projects", { path })).data;
  const session = (await req(host, "/sessions", { projectId: project.id }))
    .data;
  host.store.enqueue(session.id, "Retained message", { kind: "gui" });
  const renamed = await req(
    host,
    `/projects/${project.id}`,
    { name: "Renamed", archived: true },
    "PATCH",
  );
  expect(renamed.status).toBe(200);
  expect(renamed.data).toMatchObject({ name: "Renamed", archived: true });
  expect(
    (await req(host, `/projects/${project.id}`, { archived: "false" }, "PATCH"))
      .status,
  ).toBe(400);
  expect(
    (await req(host, `/projects/${project.id}`, { archived: false }, "PATCH"))
      .data.archived,
  ).toBe(false);
  expect(
    (await req(host, `/projects/${project.id}`, undefined, "DELETE")).status,
  ).toBe(200);
  expect(host.store.session(session.id)).toMatchObject({
    projectId: null,
    cwd: path,
  });
  expect(
    (await req(host, `/sessions/${session.id}/history`)).data.inputs[0].text,
  ).toBe("Retained message");
  expect(await Bun.file(file).text()).toBe("local file");
  expect(
    (await req(host, `/projects/${project.id}`, undefined, "DELETE")).status,
  ).toBe(404);
});

test("reply forks keep only the selected history, persist independently and reject invalid boundaries", async () => {
  const host = setup();
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const source = host.store.createSession({
    title: "分支来源",
    model: "fixture",
    thinking: "high",
  });
  const manager = SessionManager.create(
    source.cwd,
    join(host.store.root, "sessions", source.id),
  );
  const reply = (text: string, calls = false): any => ({
    role: "assistant",
    content: [
      { type: "text", text },
      ...(calls
        ? [{ type: "toolCall", id: "call-1", name: "glob", arguments: {} }]
        : []),
    ],
    api: "openai-completions",
    provider: "openai",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls ? "toolUse" : "stop",
    timestamp: Date.now(),
  });
  manager.appendCustomEntry("bro_input", {
    id: "original-input",
    text: "第一问",
    annotations: [{ messageId: "quote", quote: "原文", comment: "批注" }],
  });
  const userId = manager.appendMessage({
    role: "user",
    content: "第一问",
    timestamp: Date.now(),
  });
  const firstId = manager.appendMessage(reply("先检查文件", true));
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "glob",
    content: [{ type: "text", text: "test.ts" }],
    isError: false,
    timestamp: Date.now(),
  });
  const secondId = manager.appendMessage(reply("第一问完成"));
  manager.appendCustomEntry("bro_input", {
    id: "later-input",
    text: "后续问题",
  });
  manager.appendMessage({
    role: "user",
    content: "后续问题",
    timestamp: Date.now(),
  });
  const lastId = manager.appendMessage(reply("后续答案"));
  await manager.flush();
  const originalFile = manager.getSessionFile()!;
  await manager.close();
  host.store.updateSession(source.id, { runtimeFile: originalFile });
  const originalBytes = readFileSync(originalFile, "utf8");
  const artifacts = originalFile.slice(0, -6);
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "1.glob.log"), "artifact content");
  let firstFork: any;
  for (const [messageId, count] of [
    [firstId, 2],
    [secondId, 4],
    [lastId, 6],
  ] as const) {
    const response = await req(host, `/sessions/${source.id}/fork`, {
      messageId,
    });
    expect(response.status).toBe(200);
    const fork = response.data;
    firstFork ??= fork;
    expect(fork).toMatchObject({
      cwd: source.cwd,
      projectId: source.projectId,
      model: "fixture",
      thinking: "high",
      status: "idle",
    });
    expect(host.store.inputs(fork.id)).toEqual([]);
    expect(host.store.memoryScope(fork.id)).toBe(
      host.store.memoryScope(source.id),
    );
    const history = (await req(host, `/sessions/${fork.id}/history`)).data
      .messages;
    expect(history).toHaveLength(count);
    expect(history.at(-1).id).toBe(messageId);
    expect(history[0].bro.inputs[0].annotations[0].comment).toBe("批注");
    expect(
      readFileSync(join(fork.runtimeFile.slice(0, -6), "1.glob.log"), "utf8"),
    ).toBe("artifact content");
    if (messageId === firstId) {
      expect(history.at(-1).content).toEqual([
        { type: "text", text: "先检查文件" },
      ]);
      expect(history.at(-1).stopReason).toBe("stop");
      expect(readFileSync(fork.runtimeFile, "utf8")).not.toContain("后续答案");
    }
  }
  const reopened = await SessionManager.open(firstFork.runtimeFile);
  reopened.appendMessage({
    role: "user",
    content: "分支独立续聊",
    timestamp: Date.now(),
  });
  reopened.appendMessage(reply("分支答案"));
  await reopened.close();
  const history = (await req(host, `/sessions/${firstFork.id}/history`)).data
    .messages;
  expect(history).toHaveLength(4);
  expect(history.at(-1).content[0].text).toBe("分支答案");
  expect(readFileSync(originalFile, "utf8")).toBe(originalBytes);
  const count = host.store.sessions().length;
  for (const boundary of [
    {},
    { messageId: userId },
    { messageId: "missing-reply" },
  ]) {
    expect(
      (await req(host, `/sessions/${source.id}/fork`, boundary)).status,
    ).toBe(400);
    expect(host.store.sessions()).toHaveLength(count);
  }
}, 30000);

test("desktop resumes from a fresh GUI or Feishu task, never the paused task or an automatic monitor event", async () => {
  const host = setup();
  const session = (await req(host, "/sessions", {})).data;
  const original = host.store.enqueue(session.id, "work", { kind: "gui" });
  const desktop = host.state().desktop;
  desktop.enabled = true;
  desktop.detectorReady = true;
  await req(host, "/desktop/pause", {});
  await expect(
    host.runtimes.hostCall!(session.id, original.id, "bro_computer", {
      resume: true,
    }),
  ).rejects.toThrow("新的继续指令");
  expect(desktop.paused).toBe(true);
  for (const kind of ["gui", "feishu"] as const) {
    await Bun.sleep(2);
    const input = host.store.enqueue(session.id, "准备好了，继续", { kind });
    expect(
      await host.runtimes.hostCall!(session.id, input.id, "bro_computer", {
        resume: true,
      }),
    ).toMatchObject({ resumed: true });
    expect(desktop.paused).toBe(false);
    await req(host, "/desktop/pause", {});
  }
  await Bun.sleep(2);
  const automatic = host.store.enqueue(session.id, "continue", {
    kind: "monitor",
  });
  await expect(
    host.runtimes.hostCall!(session.id, automatic.id, "bro_computer", {
      resume: true,
    }),
  ).rejects.toThrow("新的继续指令");
  expect(desktop.paused).toBe(true);
});

test("Feishu onboarding endpoints require host auth and never expose device credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "bro-host-setup-"));
  prepareRoot(root);
  let calls = 0;
  const host = createHost(root, "test-token", {
    runtimeFactory: NoModelRuntime,
    feishuSetupFetch: (async (_url: any, init: RequestInit) => {
      calls++;
      return Response.json(
        new URLSearchParams(String(init.body)).get("action") === "begin"
          ? { device_code: "private-device", user_code: "test", expire_in: 600 }
          : { error: "authorization_pending" },
      );
    }) as typeof fetch,
  });
  hosts.push(host);
  for (const action of ["start", "retry", "cancel", "pair"]) {
    const response = await fetch(
      `http://127.0.0.1:${host.server.port}/feishu/setup/${action}`,
      { method: "POST" },
    );
    expect(response.status).toBe(401);
  }
  expect(calls).toBe(0);
  expect((await req(host, "/feishu/setup/start", {})).status).toBe(200);
  for (
    let i = 0;
    i < 100 && host.feishuSetup.state().status === "starting";
    i++
  )
    await Bun.sleep(5);
  const current = (await req(host, "/state")).data;
  expect(current.feishu.setup.status).toBe("waiting");
  expect(current.feishu.setup.qrCode).toStartWith("data:image/gif");
  expect(JSON.stringify(current)).not.toContain("private-device");
  expect((await req(host, "/feishu/setup/cancel", {})).data.status).toBe(
    "cancelled",
  );
  expect(host.store.getSettings().trustedFeishuUsers).toEqual([]);
});
