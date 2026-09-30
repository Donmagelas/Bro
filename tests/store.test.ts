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
test("delegation results keep original reply correlation and enqueue exactly once", () => {
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
