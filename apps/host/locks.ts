/** FIFO, abortable coordination for sessions sharing one project directory. */
export class WorkspaceLocks {
  private tails = new Map<string, Promise<void>>();
  busy(key: string) {
    return this.tails.has(key);
  }
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const previous = this.tails.get(key) || Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    let onAbort: () => void = () => {};
    try {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DOMException("等待已取消", "AbortError"));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      signal?.throwIfAborted();
    } catch (error) {
      unlock();
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    };
  }
}
