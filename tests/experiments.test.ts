import { expect, test } from "bun:test";
import {
  select,
  contextCandidates,
  type SelectionRecord,
} from "../packages/experiments/selection";
const candidates = [
  { id: "a", text: "old" },
  { id: "b", text: "constraint", required: true },
];
test("normal makes no backend call and shadow preserves the original input", async () => {
  let calls = 0;
  const records: SelectionRecord[] = [];
  const judge = async () => {
    calls++;
    return { scores: { a: 0, b: 0 } };
  };
  expect(
    await select("context", "normal", "task", candidates, judge, (r) =>
      records.push(r),
    ),
  ).toBe(candidates);
  expect(calls).toBe(0);
  expect(
    await select("context", "shadow", "task", candidates, judge, (r) =>
      records.push(r),
    ),
  ).toBe(candidates);
  expect(records[0]?.applied).toBe(false);
  expect(
    await select("context", "experimental", "task", candidates, judge, (r) =>
      records.push(r),
    ),
  ).toEqual([candidates[1]!]);
});
test("invalid or failed judgments fall back without mutating candidates", async () => {
  const record = () => {};
  expect(
    await select(
      "skills",
      "experimental",
      "task",
      candidates,
      async () => ({ scores: { a: 0 } }),
      record,
    ),
  ).toBe(candidates);
  expect(
    await select(
      "skills",
      "experimental",
      "task",
      candidates,
      async () => {
        throw new Error("offline");
      },
      record,
    ),
  ).toBe(candidates);
});
test("tool exchanges remain whole and unresolved/recent exchanges are protected", () => {
  const messages = [
    { role: "user", content: "request" },
    { role: "assistant", content: [{ type: "toolCall", id: "1" }] },
    { role: "toolResult", toolCallId: "1" },
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall", id: "2" }] },
    { role: "user" },
    { role: "assistant" },
    { role: "user" },
    { role: "assistant" },
  ];
  const { groups, candidates } = contextCandidates(messages);
  expect(groups[0]).toEqual([1, 2]);
  expect(candidates[1]?.required).toBe(true);
  expect(candidates[0]?.required).toBe(false);
  expect(groups.flat()).not.toContain(0);
});
