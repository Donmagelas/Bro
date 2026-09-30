import { expect, test } from "bun:test";
import {
  projectConversation,
  uncommittedMessages,
  type StreamMessage,
} from "../apps/desktop/renderer/src/conversation";
import type { ChatMessage, Input } from "../packages/contracts";
const input = (id: string, status: Input["status"]): Input => ({
  id,
  sessionId: "s",
  text: id,
  source: { kind: "gui" },
  attachments: [],
  annotations: [],
  status,
  createdAt: 1,
});
const user = (i: Input): ChatMessage => ({
  id: `saved-${i.id}`,
  role: "user",
  content: i.text,
  bro: { inputs: [i] },
});
const reply = (id: string, text: string, timestamp: number): StreamMessage => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
  streaming: true,
});

test("current input precedes streaming output while queued follow-ups stay out of history", () => {
  const first = input("first", "running"),
    later = input("later", "queued");
  const result = projectConversation(
    [],
    [reply("live", "partial", 2)],
    [first, later],
    null,
    false,
  );
  expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(result.queue.map((i) => i.id)).toEqual(["later"]);
  const startup = projectConversation(
    [],
    [],
    [input("first", "queued"), later],
    null,
    true,
  );
  expect(startup.messages.map((m) => m.content)).toEqual(["first"]);
  expect(startup.queue.map((i) => i.id)).toEqual(["later"]);
});

test("accepted input and saved history each replace an optimistic message without duplication", () => {
  const first = input("first", "running");
  const outgoing = { ...first, queued: false };
  expect(
    projectConversation([], [], [], outgoing, false).messages,
  ).toHaveLength(1);
  expect(
    projectConversation([], [], [first], outgoing, false).messages,
  ).toHaveLength(1);
  expect(
    projectConversation([user(first)], [], [first], outgoing, false).messages,
  ).toHaveLength(1);
  const queued = projectConversation(
    [user(first)],
    [],
    [first],
    { ...input("later", "queued"), queued: true },
    false,
  );
  expect(queued.messages).toHaveLength(1);
  expect(queued.sending?.id).toBe("later");
});

test("completed stream survives delayed history and is replaced exactly once by saved output", () => {
  const a = { ...reply("live-a", "先检查代码", 2), streaming: false };
  const b = reply("live-b", "已经修复", 4);
  expect(uncommittedMessages([], [a, b])).toEqual([a, b]);
  const history: ChatMessage[] = [
    { ...a, id: "persisted-a" },
    { id: "tool", role: "toolResult", content: "OK", timestamp: 3 },
  ];
  expect(
    projectConversation(history, [a, b], [], null, false).messages.map(
      (m) => m.id,
    ),
  ).toEqual(["persisted-a", "tool", "live-b"]);
  expect(
    uncommittedMessages([...history, { ...b, id: "persisted-b" }], [a, b]),
  ).toEqual([]);
  expect(uncommittedMessages([{ ...a, id: "old", timestamp: 1 }], [a])).toEqual(
    [a],
  );
});

test("duplicate equal responses are matched individually and hidden internal roles do not appear as Bro", () => {
  const a = reply("a", "完成", 2),
    b = reply("b", "完成", 2);
  expect(uncommittedMessages([{ ...a, id: "saved" }], [a, b])).toEqual([b]);
  const failed = input("failed", "failed");
  failed.error = "请求失败";
  const result = projectConversation(
    [{ id: "internal", role: "developer", content: "private instruction" }],
    [],
    [failed, input("stopped", "cancelled")],
    null,
    false,
  );
  expect(result.messages.map((m) => m.delivery)).toEqual([
    "failed",
    "cancelled",
  ]);
  expect(result.messages[0]?.error).toBe("请求失败");
});
