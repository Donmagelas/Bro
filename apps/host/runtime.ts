import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendFileSync, realpathSync } from "node:fs";
import { WorkspaceLocks } from "./locks";
import { displayHistory } from "../../packages/runtime-omp/history";
import type { Store } from "./store";
import type { Input, RpcMessage, RuntimeEvent } from "../../packages/contracts";

interface Worker {
  releasing?: boolean;
  process: ReturnType<typeof Bun.spawn>;
  ready: Promise<void>;
  calls: Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >;
}
export class Runtimes {
  private workers = new Map<string, Worker>();
  private running = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private closing = false;
  private stale = new Set<string>();
  private locks = new WorkspaceLocks();
  private waiting = new Map<string, AbortController>();
  private aborted = new Set<string>();
  private titling = new Set<string>();
  get pendingRefresh() {
    return [...this.stale];
  }
  beforeStop?: (sessionId: string) => void;
  hostCall?: (
    sessionId: string,
    inputId: string,
    action: string,
    args: any,
  ) => Promise<any>;
  constructor(
    private store: Store,
    private emit: (event: RuntimeEvent) => void,
    private changed: () => void,
    private replied: () => void,
  ) {}
  private call(
    worker: Worker,
    type: string,
    args: Record<string, unknown> = {},
    timeout = 60000,
  ): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            worker.calls.delete(id);
            reject(new Error(`运行命令超时：${type}`));
          }, timeout)
        : undefined;
      worker.calls.set(id, { resolve, reject, timer });
      worker.process.send({ id, type, ...args });
    });
  }
  private async worker(id: string): Promise<Worker> {
    if (this.closing) throw new Error("后台正在退出");
    let worker = this.workers.get(id);
    if (worker) {
      await worker.ready;
      return worker;
    }
    const session = this.store.session(id);
    if (!session) throw new Error("会话不存在");
    const connection = this.store.connection(
      session.connectionId ||
        this.store.getSettings().defaultConnectionId ||
        "",
    );
    if (!connection) throw new Error("请先配置并选择模型连接");
    let readyResolve!: () => void, readyReject!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const calls: Worker["calls"] = new Map();
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../packages/runtime-omp/worker.ts"),
      ],
      {
        cwd: session.cwd,
        env: {
          ...process.env,
          BRO_DATA_DIR: this.store.root,
          PI_CODING_AGENT_DIR: join(this.store.root, "agent"),
          PI_NO_TITLE: "1", // Bro owns the first-message title and manual-rename guard.
        },
        stdout: "pipe",
        stderr: "pipe",
        ipc: (message: RpcMessage) => {
          if (message.type === "booted") {
            void this.call(
              worker!,
              "init",
              {
                config: {
                  root: this.store.root,
                  memoryScope: this.store.memoryScope(id),
                  session,
                  connection,
                  settings: this.store.getSettings(),
                  resources: this.store.getConfig("resources", []),
                  experimentKey: this.store.getConfig("experimentKey", ""),
                },
              },
              180000,
            ).catch(readyReject);
          } else if (message.type === "ready") {
            this.store.setConfig(`runtimeInfo:${id}`, {
              tools: message.tools,
              skills: message.skills,
              mcp: message.mcp,
              warnings: message.warnings,
              memory: message.memory,
              at: Date.now(),
            });
            this.store.updateSession(id, {
              runtimeFile: String(message.runtimeFile),
              status: "idle",
              error: null,
            });
            readyResolve();
            this.changed();
          } else if (message.type === "response") {
            const pending = calls.get(message.id!);
            if (!pending) return;
            calls.delete(message.id!);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(String(message.error)));
            else pending.resolve(message.result);
          } else if (message.type === "event")
            this.emit({ sessionId: id, type: "runtime", data: message.event });
          else if (message.type === "host_call") {
            void Promise.resolve()
              .then(() =>
                this.hostCall?.(
                  id,
                  String(message.inputId),
                  String(message.action),
                  message.args,
                ),
              )
              .then(
                (result) =>
                  proc.send({ type: "host_result", id: message.id, result }),
                (error) =>
                  proc.send({
                    type: "host_result",
                    id: message.id,
                    error: String(error),
                  }),
              )
              .catch(() => {}); // A result may arrive after its worker was stopped.
          }
        },
      },
    );
    worker = { process: proc, ready, calls };
    this.workers.set(id, worker);
    const bootTimer = setTimeout(
      () => readyReject(new Error("OMP 进程初始化超时")),
      190000,
    );
    const log = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream)
        appendFileSync(join(this.store.root, "logs", `${id}.log`), chunk);
    };
    void log(proc.stdout as ReadableStream<Uint8Array>);
    void log(proc.stderr as ReadableStream<Uint8Array>);
    void proc.exited.then((code) => {
      this.beforeStop?.(id);
      const error = new Error(`会话运行进程退出 (${code})`);
      readyReject(error);
      for (const pending of calls.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      calls.clear();
      if (this.workers.get(id) !== worker) return;
      this.workers.delete(id);
      if (
        !this.closing &&
        !worker?.releasing &&
        this.store.session(id) &&
        this.store.session(id)?.status !== "error"
      ) {
        this.store.updateSession(id, {
          status: this.running.has(id) ? "interrupted" : "idle",
          error: this.running.has(id) ? error.message : null,
        });
        this.changed();
      }
    });
    try {
      await ready;
      return worker;
    } catch (error) {
      proc.kill();
      this.workers.delete(id);
      throw error;
    } finally {
      clearTimeout(bootTimer);
    }
  }
  async history(id: string) {
    const worker = this.workers.get(id);
    if (worker && !worker.releasing) {
      try {
        await worker.ready;
        if (!worker.releasing) return await this.call(worker, "history");
      } catch (error) {
        if (!worker.releasing) throw error;
        // A normal model change can retire the process during this read.
      }
    }
    const session = this.store.session(id);
    if (!session?.runtimeFile) return [];
    // History browsing doesn't require an authenticated model or a live execution process.
    const name = "@oh-my-pi/pi-coding-agent";
    const { SessionManager } = await import(name);
    const manager = await SessionManager.open(session.runtimeFile);
    try {
      return displayHistory(manager);
    } finally {
      await manager.close();
    }
  }
  async stats(id: string) {
    const worker = this.workers.get(id);
    if (worker && !worker.releasing) {
      try {
        await worker.ready;
        if (!worker.releasing) {
          const result = await this.call(worker, "stats");
          this.store.setConfig(`runtimeStats:${id}`, result);
          return result;
        }
      } catch (error) {
        if (!worker.releasing) throw error;
      }
    }
    return this.store.getConfig(`runtimeStats:${id}`, null);
  }
  async memory(id: string, query?: string) {
    const worker = this.workers.get(id);
    if (!worker)
      return { active: false, message: "会话运行后可查看实际记忆状态" };
    await worker.ready;
    return this.call(worker, "memory", { query });
  }
  async steer(id: string, input: Partial<Input>) {
    const worker = this.workers.get(id);
    if (!worker || this.store.session(id)?.status !== "running")
      throw new Error("当前会话没有可 steer 的运行");
    await this.call(worker, "steer", { input });
  }
  async stop(id: string) {
    if (this.running.has(id)) this.aborted.add(id);
    this.beforeStop?.(id);
    this.waiting.get(id)?.abort();
    const worker = this.workers.get(id);
    if (worker) {
      await worker.ready;
      await this.call(worker, "abort", {}, 15000);
    }
  }
  compact(id: string) {
    return this.track(
      this.exclusive(id, async () => {
        if (this.stale.has(id)) await this.disposeWorker(id);
        const session = this.store.session(id);
        if (!session) throw new Error("会话不存在");
        const controller = new AbortController();
        this.waiting.set(id, controller);
        const path = realpathSync(session.cwd);
        let unlock: (() => void) | undefined;
        try {
          this.store.updateSession(id, { status: "waiting", error: null });
          this.changed();
          unlock = await this.locks.acquire(
            process.platform === "win32" ? path.toLowerCase() : path,
            controller.signal,
          );
          const worker = await this.worker(id);
          if (controller.signal.aborted)
            throw new DOMException("已停止", "AbortError");
          this.store.updateSession(id, { status: "running" });
          this.changed();
          const result = await this.call(worker, "compact", {}, 180000);
          this.emit({
            sessionId: id,
            type: "history",
            data: await this.call(worker, "history"),
          });
          return result;
        } finally {
          this.waiting.delete(id);
          unlock?.();
          this.store.updateSession(id, { status: "idle" });
          this.changed();
        }
      }),
    );
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("后台正在退出");
    if (this.running.has(id)) throw new Error("请先停止当前运行");
    this.running.add(id);
    try {
      return await work();
    } finally {
      this.running.delete(id);
      this.aborted.delete(id);
      if (!this.closing && this.store.session(id)?.queued) this.wake(id);
    }
  }
  release(id: string, after?: () => void) {
    return this.track(
      this.exclusive(id, async () => {
        await this.disposeWorker(id);
        after?.();
      }),
    );
  }
  configure(id: string, update: Parameters<Store["updateSession"]>[1]) {
    this.store.updateSession(id, update);
    // Keep the current turn intact. The next drain boundary reloads only this session.
    if (this.workers.has(id)) this.stale.add(id);
    this.changed();
  }
  private async disposeWorker(id: string) {
    const worker = this.workers.get(id);
    if (worker) {
      await worker.ready;
      if ((await this.call(worker, "activity")).busy)
        throw new Error("会话仍有后台工具或子任务；结束后再更改运行配置");
      worker.releasing = true;
      await this.call(worker, "dispose", {}, 30000);
      await worker.process.exited;
      if (this.workers.get(id) === worker) this.workers.delete(id);
    }
    this.stale.delete(id);
  }
  async refresh() {
    for (const id of this.workers.keys()) this.stale.add(id);
    await Promise.allSettled(
      [...this.stale]
        .filter((id) => !this.running.has(id))
        .map((id) => this.release(id)),
    );
    this.changed();
  }
  wake(id: string) {
    if (!this.closing) void this.track(this.drain(id));
  }
  wakeAll() {
    for (const s of this.store.sessions())
      if (s.queued && s.status !== "interrupted") this.wake(s.id);
  }
  private startTitle(id: string, worker: Worker) {
    const input = this.store.pendingTitle(id);
    if (!input || this.titling.has(id)) return;
    this.titling.add(id);
    void this.track(
      this.call(worker, "title", { text: input.text.slice(0, 6000) }, 35000)
        .then((title) => {
          if (
            this.store.completeTitle(
              id,
              input.id,
              typeof title === "string" ? title : null,
            )
          )
            this.changed();
        })
        .catch(() => {
          this.store.completeTitle(id, input.id, null);
        })
        .finally(() => this.titling.delete(id)),
    );
  }
  private async drain(id: string) {
    if (this.closing || this.running.has(id)) return;
    this.running.add(id);
    let input: Input | null = null;
    try {
      const s = this.store.session(id);
      if (!s || s.archived || s.status === "interrupted") return;
      if (!s.connectionId && !this.store.getSettings().defaultConnectionId)
        return;
      this.store.updateSession(id, { status: "starting", error: null });
      this.changed();
      if (this.stale.has(id)) {
        await this.disposeWorker(id);
      }
      let worker = await this.worker(id);
      this.startTitle(id, worker);
      while (!this.closing && (input = this.store.claim(id))) {
        this.aborted.delete(id);
        let unlock: (() => void) | undefined;
        try {
          const path = realpathSync(s.cwd),
            key = process.platform === "win32" ? path.toLowerCase() : path;
          const controller = new AbortController();
          this.waiting.set(id, controller);
          this.store.updateSession(id, {
            status: this.locks.busy(key) ? "waiting" : "running",
            error: null,
          });
          this.changed();
          unlock = await this.locks.acquire(key, controller.signal);
          this.waiting.delete(id);
          this.store.updateSession(id, { status: "running" });
          this.changed();
          const result = await this.call(worker, "prompt", { input }, 0);
          if (result.stats)
            this.store.setConfig(`runtimeStats:${id}`, result.stats);
          const status =
            this.aborted.delete(id) || result.stopReason === "aborted"
              ? "cancelled"
              : "completed";
          this.store.db.transaction(() => {
            this.store.finishInput(input!.id, status);
            this.store.completeDelegation(
              input!,
              result.text || "运行结束，无文本结果。",
              status,
            );
            if (!input!.parentRequestId)
              this.store.addReply(
                input!.id,
                input!.source,
                result.text || "运行已结束。",
              );
          })();
          this.emit({ sessionId: id, type: "history", data: result.history });
          this.replied();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const status =
            error instanceof DOMException && error.name === "AbortError"
              ? "cancelled"
              : this.workers.has(id)
                ? "failed"
                : "interrupted";
          this.store.finishInput(input.id, status, message);
          this.store.completeDelegation(input, message, status);
          if (!input.parentRequestId)
            this.store.addReply(
              input.id,
              input.source,
              `任务未完成：${message}`,
            );
          this.store.updateSession(id, {
            status: status === "interrupted" ? "interrupted" : "error",
            error: message,
          });
          this.replied();
          break;
        } finally {
          this.waiting.delete(id);
          unlock?.();
        }
        input = null;
        if (this.stale.has(id)) {
          await this.disposeWorker(id);
          if (this.store.session(id)?.queued) worker = await this.worker(id);
          else break;
        }
      }
      if (
        this.store.session(id)?.status === "running" ||
        this.store.session(id)?.status === "starting"
      )
        this.store.updateSession(id, { status: "idle" });
    } catch (error) {
      if (this.store.session(id))
        this.store.updateSession(id, { status: "error", error: String(error) });
    } finally {
      this.running.delete(id);
      this.changed();
      if (!this.closing)
        for (const s of this.store.sessions())
          if (
            s.queued &&
            s.status === "idle" &&
            (s.connectionId || this.store.getSettings().defaultConnectionId)
          )
            this.wake(s.id);
    }
  }
  async shutdown() {
    this.closing = true;
    for (const controller of this.waiting.values()) controller.abort();
    await Promise.allSettled(
      [...this.workers.values()].map(async (w) => {
        try {
          await this.call(w, "dispose", {}, 15000);
        } finally {
          w.process.kill();
          await w.process.exited;
        }
      }),
    );
    await Promise.allSettled([...this.pending]);
    this.workers.clear();
  }
}
