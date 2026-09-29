import { expect, test } from "bun:test";
import { WorkspaceLocks } from "../apps/host/locks";
test("same directory serializes, another directory progresses, and cancelled waiter does not block the next", async () => {
  const locks = new WorkspaceLocks(),
    first = await locks.acquire("a"),
    abort = new AbortController();
  const second = locks.acquire("a", abort.signal);
  let thirdEntered = false;
  const third = locks.acquire("a").then((release) => {
    thirdEntered = true;
    release();
  });
  const independent = await locks.acquire("b");
  expect(thirdEntered).toBe(false);
  independent();
  abort.abort();
  await expect(second).rejects.toThrow();
  first();
  await third;
  expect(thirdEntered).toBe(true);
});
