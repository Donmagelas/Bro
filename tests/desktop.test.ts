import { expect, test } from "bun:test";
import { Desktop } from "../apps/host/desktop";
test("human takeover blocks later operations in a batch and persists until manual resume", async () => {
  const calls: string[] = [];
  let desktop: Desktop;
  desktop = new Desktop(
    "/unused",
    () => {},
    async () => ({
      capabilities: {},
      async typeText(_target: string, text: string) {
        calls.push(text);
        desktop.inputEvent({ type: "human" });
      },
      async click() {
        calls.push("click");
      },
    }),
  );
  desktop.state.enabled = true;
  desktop.inputEvent({ type: "ready" });
  await expect(
    desktop.execute("one", [
      { method: "typeText", args: ["window", "abcdefghijklmnopqrstuvwxyz"] },
      { method: "click", args: [] },
    ]),
  ).rejects.toThrow("暂停");
  expect(calls).toEqual(["abcdefghijklmnop"]);
  expect(desktop.state.paused).toBe(true);
  expect(desktop.state.owner).toBeNull();
  await expect(desktop.execute("two", [{ method: "click" }])).rejects.toThrow(
    "暂停",
  );
  desktop.resume();
  await desktop.execute("two", [{ method: "click" }]);
  expect(calls.at(-1)).toBe("click");
});

test("capture uses the native desktop target and preserves explicit window ids", async () => {
  const targets: string[] = [];
  const desktop = new Desktop(
    "/unused",
    () => {},
    async () => ({
      capabilities: {},
      async capture(target: string) {
        targets.push(target);
        return { data: new Uint8Array([1, 2]), width: 1, height: 1, target };
      },
    }),
  );
  desktop.state.enabled = true;
  desktop.inputEvent({ type: "ready" });
  const result = await desktop.execute("one", [
    { method: "capture" },
    { method: "capture", args: ["12345"] },
  ]);
  expect(targets).toEqual(["desktop", "12345"]);
  expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
});
