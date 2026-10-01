import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/host/store";
const stores: Store[] = [];
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "bro-store-")));
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("queue order and idempotency survive a host restart without replaying a claimed task", () => {
  const s = setup(),
    session = s.createSession();
  const a = s.enqueue(session.id, "first", { kind: "gui" }, { id: "first" }),
    b = s.enqueue(session.id, "second", { kind: "gui" }, { id: "second" });
  expect(
    s.enqueue(session.id, "first", { kind: "gui" }, { id: "first" }).id,
  ).toBe(a.id);
  expect(() =>
    s.enqueue(session.id, "changed", { kind: "gui" }, { id: "first" }),
  ).toThrow();
  expect(s.claim(session.id)?.id).toBe(a.id);
  expect(s.claim(session.id)).toBeNull();
  s.close();
  const reopened = new Store(s.root);
  stores[stores.indexOf(s)] = reopened;
  reopened.recover();
  expect(reopened.input(a.id)?.status).toBe("interrupted");
  expect(reopened.claim(session.id)?.id).toBe(b.id);
});
test("group member bindings reuse then replace archived sessions without leaking other member histories", () => {
  const s = setup(),
    source = {
      kind: "feishu" as const,
      senderId: "a",
      chatId: "g",
      messageId: "m1",
    };
  const first = s.ingest("m1", "g:a", "hello", source, "a")!;
  expect(s.ingest("m1", "g:a", "hello", source, "a")).toBeNull();
  const next = s.ingest(
    "m2",
    "g:a",
    "again",
    { ...source, messageId: "m2" },
    "a",
  )!;
  const other = s.ingest(
    "m3",
    "g:b",
    "another",
    { ...source, senderId: "b", messageId: "m3" },
    "b",
  )!;
  expect(first.sessionId).toBe(next.sessionId);
  expect(other.sessionId).not.toBe(first.sessionId);
  s.updateSession(first.sessionId, { archived: true });
  const after = s.ingest(
    "m4",
    "g:a",
    "new",
    { ...source, messageId: "m4" },
    "a",
  )!;
  expect(after.sessionId).not.toBe(first.sessionId);
  expect(s.inputs(after.sessionId)).toHaveLength(1);
  expect(s.sessions()).toHaveLength(2);
});
test("delete clears the binding and a subsequent event creates a fresh session", () => {
  const s = setup(),
    first = s.ingest("1", "dm:a", "hi", { kind: "feishu" }, "dm")!;
  s.deleteSession(first.sessionId);
  expect(s.bindings()).toHaveLength(0);
  const second = s.ingest("2", "dm:a", "new", { kind: "feishu" }, "dm")!;
  expect(second.sessionId).not.toBe(first.sessionId);
});
test("legacy delegation results keep original reply correlation and enqueue exactly once", () => {
  const s = setup(),
    s0 = s.createSession(),
    s1 = s.createSession(),
    s2 = s.createSession();
  const origin = {
    kind: "feishu" as const,
    connectionId: "bot",
    senderId: "owner",
    chatId: "dm",
    messageId: "original",
  };
  const original = s.enqueue(s0.id, "ask two sessions", origin);
  s.finishInput(original.id, "completed");
  const d1 = s.delegate(s0.id, s1.id, original.id, "do one"),
    d2 = s.delegate(s0.id, s2.id, original.id, "do two");
  delete d2.delivery;
  s.db
    .query("UPDATE delegations SET value=? WHERE id=?")
    .run(JSON.stringify(d2), d2.id);
  s.enqueue(s0.id, "unrelated later message", {
    ...origin,
    messageId: "latest",
  });
  const i2 = s.input(d2.targetInputId)!;
  s.completeDelegation(i2, "two done", "completed");
  s.completeDelegation(i2, "duplicate", "completed");
  const results = s.inputs(s0.id).filter((i) => i.source.requestId === d2.id);
  expect(results).toHaveLength(1);
  expect(results[0]?.source.messageId).toBe("original");
  expect(s.delegations().find((d) => d.id === d1.id)?.status).toBe("queued");
  expect(s.inputs(s1.id)[0]?.source.kind).toBe("session");
});
test("inline and send-only results never enqueue a second source turn", () => {
  const s = setup(),
    source = s.createSession(),
    target = s.createSession();
  const input = s.enqueue(source.id, "task", { kind: "gui" });
  for (const delivery of ["inline", "none"] as const) {
    const d = s.delegate(source.id, target.id, input.id, "child", delivery);
    const child = s.input(d.targetInputId)!;
    s.completeDelegation(child, "exact result", "completed");
    s.completeDelegation(child, "duplicate", "completed");
    expect(s.delegations().find((value) => value.id === d.id)?.result).toBe(
      "exact result",
    );
  }
  expect(s.inputs(source.id)).toHaveLength(1);
});
test("delegated file delivery resolves the original Feishu message through nested tasks", () => {
  const s = setup(),
    a = s.createSession(),
    b = s.createSession(),
    c = s.createSession();
  const source = {
    kind: "feishu" as const,
    connectionId: "bot",
    messageId: "original",
    chatId: "group",
  };
  const original = s.enqueue(a.id, "send file", source);
  const first = s.delegate(a.id, b.id, original.id, "produce file");
  const second = s.delegate(b.id, c.id, first.targetInputId, "send file");
  expect(s.replySource(s.input(second.targetInputId)!)).toEqual(source);
});
test("independent synchronous requests cannot form a wait cycle", () => {
  const s = setup(),
    a = s.createSession(),
    b = s.createSession(),
    c = s.createSession();
  const ia = s.enqueue(a.id, "a", { kind: "gui" });
  const ib = s.enqueue(b.id, "b", { kind: "gui" });
  const ic = s.enqueue(c.id, "c", { kind: "gui" });
  s.delegate(a.id, b.id, ia.id, "ab");
  s.delegate(b.id, c.id, ib.id, "bc");
  expect(() => s.delegate(c.id, a.id, ic.id, "ca")).toThrow("相互等待");
  expect(s.inputs(a.id)).toHaveLength(1);
});
test("restart cancels queued synchronous children of interrupted inputs without replay", () => {
  const s = setup(),
    source = s.createSession(),
    target = s.createSession();
  const input = s.enqueue(source.id, "task", {
    kind: "feishu",
    connectionId: "fixture",
    chatId: "dm",
    messageId: "original",
  });
  s.claim(source.id);
  const waiting = s.delegate(source.id, target.id, input.id, "wait");
  const sent = s.delegate(source.id, target.id, input.id, "send", "none");
  s.recover();
  expect(s.input(input.id)?.status).toBe("interrupted");
  expect(s.input(waiting.targetInputId)?.status).toBe("cancelled");
  expect(s.input(sent.targetInputId)?.status).toBe("queued");
  expect(s.inputs(source.id)).toHaveLength(1);
  s.recover();
  expect(s.pendingReplies()).toHaveLength(1);
  expect(s.pendingReplies()[0]?.source.messageId).toBe("original");
  expect(s.pendingReplies()[0]?.text).toContain("中断");
});
test("public connection listing does not expose credentials", () => {
  const s = setup();
  s.saveConnection(
    {
      id: "test",
      kind: "api",
      provider: "bro-test",
      name: "test",
      model: "test",
      contextWindow: 10000,
      maxTokens: 2000,
      reasoning: false,
      imageInput: false,
    },
    "secret-value",
  );
  expect(JSON.stringify(s.connections())).not.toContain("secret-value");
  expect(s.connection("test")?.apiKey).toBe("secret-value");
});

test("memory persists across personal sessions and replacement group bindings without crossing group members", () => {
  const store = setup();
  const a = store.createSession(),
    b = store.createSession();
  expect(store.memoryScope(a.id)).toBe(store.memoryScope(b.id));
  const source = {
    kind: "feishu" as const,
    connectionId: "bot",
    chatType: "group" as const,
    chatId: "group",
    senderId: "one",
  };
  const member = store.ingest("event-1", "member-1", "hello", source, "group")!;
  const firstScope = store.memoryScope(member.sessionId);
  store.updateSession(member.sessionId, { archived: true });
  const replacement = store.ingest(
    "event-2",
    "member-1",
    "hello",
    source,
    "group",
  )!;
  expect(store.memoryScope(replacement.sessionId)).toBe(firstScope);
  const other = store.ingest(
    "event-3",
    "member-2",
    "hello",
    { ...source, senderId: "two" },
    "group",
  )!;
  expect(store.memoryScope(other.sessionId)).not.toBe(firstScope);
  expect(firstScope).not.toBe(store.memoryScope(a.id));
});

test("legacy sessions gain a model column without losing history or inheriting a later default", () => {
  const s = setup();
  const original = s.createSession({
    title: "Existing session",
    connectionId: "account",
    thinking: "high",
  });
  s.enqueue(original.id, "Preserved message", { kind: "gui" });
  s.db.exec("ALTER TABLE sessions DROP COLUMN model");
  const upgraded = new Store(s.root);
  try {
    const session = upgraded.session(original.id)!;
    expect(session.title).toBe("Existing session");
    expect(session.connectionId).toBe("account");
    expect(session.thinking).toBe("high");
    expect(session.model).toBeNull();
    expect(upgraded.inputs(original.id)[0]?.text).toBe("Preserved message");
    upgraded.setConfig("settings", {
      ...upgraded.getSettings(),
      defaultConnectionId: "account",
      defaultModel: "new-default",
    });
    const fork = upgraded.createSession({ ...session });
    expect(fork.model).toBeNull();
    expect(upgraded.createSession().model).toBe("new-default");
  } finally {
    upgraded.close();
  }
});

test("project migration, archive and removal preserve conversations, files and memory scope", () => {
  const store = setup();
  const project = store.addProject("Project", join(store.root, "workspace"));
  const session = store.createSession({
    projectId: project.id,
    cwd: project.path,
  });
  const input = store.enqueue(session.id, "Keep this history", { kind: "gui" });
  const memoryScope = store.memoryScope(session.id);
  store.setConfig("resources", [
    { id: "project-skill", projectId: project.id },
    { id: "global-skill", projectId: null },
  ]);
  store.updateProject(project.id, { archived: true, name: "Renamed" });
  expect(store.projects()[0]).toMatchObject({
    archived: true,
    name: "Renamed",
  });
  expect(store.session(session.id)?.archived).toBe(false);
  store.close();
  const reopened = new Store(store.root);
  stores[stores.indexOf(store)] = reopened;
  expect(reopened.projects()[0]?.archived).toBe(true);
  expect(reopened.addProject("Project", project.path)).toMatchObject({
    id: project.id,
    archived: false,
    name: "Renamed",
  });
  reopened.deleteProject(project.id);
  expect(reopened.projects()).toHaveLength(0);
  expect(reopened.session(session.id)).toMatchObject({
    projectId: null,
    cwd: project.path,
  });
  expect(reopened.input(input.id)?.text).toBe("Keep this history");
  expect(reopened.memoryScope(session.id)).toBe(memoryScope);
  expect(
    reopened.getConfig<{ id: string; projectId: string | null }[]>(
      "resources",
      [],
    ),
  ).toEqual([{ id: "global-skill", projectId: null }]);
  reopened.db.exec("ALTER TABLE projects DROP COLUMN archived");
  reopened.close();
  const migrated = new Store(reopened.root);
  stores[stores.indexOf(reopened)] = migrated;
  expect(migrated.addProject("Legacy compatible", project.path).archived).toBe(
    false,
  );
  expect(migrated.input(input.id)?.text).toBe("Keep this history");
});

test("first input gets a durable fallback title and the semantic title only applies once", () => {
  let s = setup();
  const session = s.createSession();
  const text = "帮我修复登录后的跳转问题\n  然后检查首页";
  const first = s.enqueue(
    session.id,
    text,
    { kind: "gui" },
    { id: "title-first" },
  );
  expect(s.session(session.id)?.title).toBe(
    "帮我修复登录后的跳转问题 然后检查首页",
  );
  s.enqueue(session.id, text, { kind: "gui" }, { id: first.id });
  s.enqueue(session.id, "顺便调整按钮", { kind: "gui" });
  expect(s.pendingTitle(session.id)?.id).toBe(first.id);
  const updatedAt = s.session(session.id)!.updatedAt;
  s.close();
  const reopened = new Store(s.root);
  stores[stores.indexOf(s)] = reopened;
  s = reopened;
  expect(s.pendingTitle(session.id)?.text).toBe(text);
  expect(s.completeTitle(session.id, "wrong-input", "错误标题")).toBe(false);
  expect(s.completeTitle(session.id, first.id, " 修复登录跳转 ")).toBe(true);
  expect(s.session(session.id)?.title).toBe("修复登录跳转");
  expect(s.session(session.id)?.updatedAt).toBe(updatedAt);
  expect(s.completeTitle(session.id, first.id, "重复结果")).toBe(false);
  s.enqueue(session.id, "后续任务", { kind: "gui" });
  expect(s.pendingTitle(session.id)).toBeNull();
  expect(s.session(session.id)?.title).toBe("修复登录跳转");
});

test("manual rename wins even when it matches the current automatic or placeholder title", () => {
  const s = setup();
  const session = s.createSession();
  const first = s.enqueue(session.id, "修复登录跳转", { kind: "gui" });
  s.updateSession(session.id, { title: "修复登录跳转" });
  expect(s.completeTitle(session.id, first.id, "后台生成的标题")).toBe(false);
  expect(s.session(session.id)?.title).toBe("修复登录跳转");
  for (const existing of [
    s.createSession({ title: "新会话" }),
    s.createSession(),
  ]) {
    s.updateSession(existing.id, { title: "新会话" });
    s.enqueue(existing.id, "帮我自动修改文件", { kind: "gui" });
    expect(s.pendingTitle(existing.id)).toBeNull();
    expect(s.session(existing.id)?.title).toBe("新会话");
  }
  const legacy = s.createSession();
  s.db.query("DELETE FROM config WHERE key=?").run(`autoTitle:${legacy.id}`);
  s.enqueue(legacy.id, "旧会话继续聊", { kind: "gui" });
  expect(s.session(legacy.id)?.title).toBe("新会话");
});

test("title failure keeps a grapheme-safe fallback and deletion ignores late results", () => {
  const s = setup();
  const emoji = "👨‍👩‍👧‍👦";
  const session = s.createSession();
  const first = s.enqueue(session.id, emoji.repeat(60), { kind: "gui" });
  expect(s.session(session.id)?.title).toBe(emoji.repeat(48));
  expect(s.completeTitle(session.id, first.id, "\n \t")).toBe(false);
  expect(s.pendingTitle(session.id)).toBeNull();
  expect(s.session(session.id)?.title).toBe(emoji.repeat(48));
  const deleted = s.createSession();
  const input = s.enqueue(deleted.id, "帮我重构路由模块", { kind: "gui" });
  s.deleteSession(deleted.id);
  expect(s.completeTitle(deleted.id, input.id, "重构路由模块")).toBe(false);
  expect(s.session(deleted.id)).toBeNull();
  expect(s.pendingTitle(deleted.id)).toBeNull();
});
