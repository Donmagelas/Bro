import { dirname, basename } from "node:path";
import { watch, openSync, readSync, closeSync, statSync } from "node:fs";
import type { Store } from "../../apps/host/store";
import type { Subscription } from "../contracts";

export async function* readSSE(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending = (pending + decoder.decode(chunk, { stream: true })).replace(
      /\r\n/g,
      "\n",
    );
    let end: number;
    while ((end = pending.indexOf("\n\n")) >= 0) {
      if (end > 128000) throw new Error("SSE 事件超过 128 KB");
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const lines = block.split("\n");
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      const id = lines
        .find((l) => l.startsWith("id:"))
        ?.slice(3)
        .replace(/^ /, "");
      if (data) yield { data, id, replayEnd: false };
      else if (lines.some((l) => l === ": replay-end"))
        yield { data: "", id: undefined, replayEnd: true };
    }
    if (pending.length > 128000) throw new Error("SSE 事件超过 128 KB");
  }
}

export class Monitor {
  private active = new Map<string, { stop: () => void; signature: string }>();
  private flushing?: Promise<void>;
  private stopped = false;
  private pending = new Set<Promise<void>>();
  private sending = new AbortController();
  readonly errors = new Map<string, string>();
  constructor(
    private store: Store,
    private wake: (id: string) => void,
    private changed: () => void,
  ) {}
  reload() {
    if (this.stopped) return;
    const subscriptions = this.store.subscriptions();
    for (const [id, item] of this.active) {
      const next = subscriptions.find((s) => s.id === id);
      if (!next?.enabled || JSON.stringify(next) !== item.signature) {
        item.stop();
        this.active.delete(id);
      }
    }
    for (const sub of subscriptions)
      if (sub.enabled && !this.active.has(sub.id)) {
        try {
          this.start(sub);
        } catch (e) {
          this.errors.set(sub.id, String(e));
        }
      }
    this.changed();
  }
  async stop() {
    this.stopped = true;
    this.sending.abort();
    for (const item of this.active.values()) item.stop();
    this.active.clear();
    await Promise.allSettled([this.flushing, ...this.pending]);
  }
  receive(sub: Subscription, text: string, eventId?: string) {
    if (this.stopped) return;
    if (sub.kind === "peer") {
      const rec = JSON.parse(text);
      if (
        rec.to !== sub.me ||
        rec.from === sub.me ||
        !sub.trustedSenders?.includes(rec.from) ||
        !Number.isSafeInteger(rec.seq) ||
        typeof rec.body !== "string"
      )
        return;
      const source = {
        kind: "peer" as const,
        connectionId: sub.id,
        senderId: rec.from,
        messageId: String(rec.seq),
        correlationId: typeof rec.corrId === "string" ? rec.corrId : undefined,
      };
      const input = this.store.enqueue(sub.targetSessionId, rec.body, source, {
        id: `peer:${sub.id}:${rec.seq}`,
      });
      this.wake(input.sessionId);
      this.changed();
      const cursor = Number(
        this.store.getConfig<string>(`cursor:${sub.id}`, "0"),
      );
      if (rec.seq > cursor)
        this.store.setConfig(`cursor:${sub.id}`, String(rec.seq));
      return;
    }
    const source = {
      kind: "monitor" as const,
      connectionId: sub.id,
      messageId: eventId,
    };
    const input = this.store.enqueue(sub.targetSessionId, text, source, {
      id: eventId ? `monitor:${sub.id}:${eventId}` : undefined,
    });
    this.wake(input.sessionId);
    this.changed();
  }
  private start(sub: Subscription) {
    if (!this.store.session(sub.targetSessionId))
      throw new Error("目标会话不存在");
    const register = (stop: () => void) =>
      this.active.set(sub.id, { stop, signature: JSON.stringify(sub) });
    this.errors.delete(sub.id);
    if (sub.kind === "file") {
      if (!sub.path) throw new Error("未指定文件");
      let timer: ReturnType<typeof setTimeout>;
      const watcher = watch(dirname(sub.path), (_event, file) => {
        if (file && file.toString() !== basename(sub.path!)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            const size = statSync(sub.path!).size,
              bytes = Math.min(size, 64000),
              buffer = Buffer.alloc(bytes),
              fd = openSync(sub.path!, "r");
            try {
              readSync(fd, buffer, 0, bytes, size - bytes);
            } finally {
              closeSync(fd);
            }
            this.receive(
              sub,
              `文件变化：${sub.path}\n${size > bytes ? "（以下为末尾 64 KB；需要完整内容请读取原文件）\n" : ""}${buffer.toString("utf8")}`,
            );
          } catch (e) {
            this.errors.set(sub.id, String(e));
            this.changed();
          }
        }, 200);
      });
      watcher.on("error", (e) => {
        this.errors.set(sub.id, String(e));
        this.changed();
      });
      register(() => {
        clearTimeout(timer);
        watcher.close();
      });
    } else if (sub.kind === "process") {
      if (!sub.command?.length) throw new Error("未指定命令");
      const child = Bun.spawn(sub.command, {
        cwd: this.store.getSettings().defaultCwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      let cancelled = false;
      const consume = async () => {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            if (line.length > 64000) throw new Error("单行事件超过 64 KB");
            if (line.trim() && !cancelled) this.receive(sub, line);
          }
          if (pending.length > 64000) throw new Error("单行事件超过 64 KB");
        }
        if (pending.trim() && !cancelled) this.receive(sub, pending);
      };
      void consume().catch((e) => {
        if (!cancelled) {
          this.errors.set(sub.id, String(e));
          child.kill();
          this.changed();
        }
      });
      let stderr = "";
      void (async () => {
        for await (const chunk of child.stderr)
          stderr = (stderr + new TextDecoder().decode(chunk)).slice(-2000);
      })().catch(() => {});
      void child.exited.then((code) => {
        if (!cancelled) {
          this.errors.set(sub.id, `进程已退出 (${code}) ${stderr}`);
          this.changed();
        }
      });
      register(() => {
        cancelled = true;
        child.kill();
      });
    } else {
      if (!sub.url) throw new Error("未指定 SSE 地址");
      const controller = new AbortController();
      register(() => controller.abort());
      const task = this.sse(sub, controller.signal);
      this.pending.add(task);
      void task.then(
        () => this.pending.delete(task),
        () => this.pending.delete(task),
      );
    }
  }
  private async sse(sub: Subscription, signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const cursor = this.store.getConfig<string>(`cursor:${sub.id}`, "");
        const url = new URL(sub.kind === "peer" ? "/sub" : sub.url!, sub.url);
        const headers = new Headers({ Accept: "text/event-stream" });
        const secret = this.store.getConfig<string>(
          `monitorSecret:${sub.id}`,
          "",
        );
        if (secret) headers.set("Authorization", `Bearer ${secret}`);
        if (sub.kind === "peer") {
          url.searchParams.set("me", sub.me!);
          url.searchParams.set("since", cursor || "0");
          url.searchParams.set(
            "mode",
            this.store.session(sub.targetSessionId)?.connectionId ||
              this.store.getSettings().defaultConnectionId
              ? "auto"
              : "manual",
          );
        } else if (cursor) headers.set("Last-Event-ID", cursor);
        const response = await fetch(url, { headers, signal });
        if (!response.ok || !response.body)
          throw new Error(`SSE HTTP ${response.status}`);
        this.errors.delete(sub.id);
        this.changed();
        let replaying = sub.kind === "peer";
        const replay: any[] = [];
        for await (const event of readSSE(response.body)) {
          if (signal.aborted) break;
          if (replaying) {
            if (event.replayEnd) {
              replaying = false;
              replay.sort((a, b) => a.seq - b.seq);
              for (const rec of replay) this.receive(sub, JSON.stringify(rec));
              replay.length = 0;
            } else if (event.data) {
              if (replay.length >= 5000)
                throw new Error("Peer 积压超过 5000 条，需要缩小补投范围");
              replay.push(JSON.parse(event.data));
            }
            continue;
          }
          if (event.data) this.receive(sub, event.data, event.id);
          if (sub.kind !== "peer" && event.id)
            this.store.setConfig(`cursor:${sub.id}`, event.id);
        }
        if (!signal.aborted) throw new Error("事件连接已断开，正在重连");
      } catch (error) {
        if (!signal.aborted) {
          this.errors.set(sub.id, String(error));
          this.changed();
        }
      }
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 3000);
          signal.addEventListener("abort", done, { once: true });
        });
    }
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.stopped) return Promise.resolve();
    const work = this.sendReplies();
    this.flushing = work;
    void work
      .finally(() => {
        this.flushing = undefined;
        if (
          !this.stopped &&
          this.store
            .pendingReplies()
            .some(
              (r) =>
                r.source.kind === "peer" &&
                this.store
                  .subscriptions()
                  .some((s) => s.id === r.source.connectionId && s.enabled),
            )
        )
          queueMicrotask(() => void this.flush());
      })
      .catch(() => {});
    return work;
  }
  private async sendReplies() {
    try {
      for (const reply of this.store
        .pendingReplies()
        .filter((r) => r.source.kind === "peer")) {
        if (this.stopped) break;
        const sub = this.store
          .subscriptions()
          .find((s) => s.id === reply.source.connectionId);
        if (!sub?.enabled || sub.kind !== "peer") continue;
        this.store.replyStatus(reply.id, "sending");
        try {
          const response = await fetch(new URL("/send", sub.url), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.store.getConfig(`monitorSecret:${sub.id}`, "")}`,
            },
            body: JSON.stringify({
              from: sub.me,
              to: reply.source.senderId,
              body: reply.text,
              corrId: reply.source.correlationId || null,
            }),
            signal: AbortSignal.any([
              this.sending.signal,
              AbortSignal.timeout(15000),
            ]),
          });
          if (!response.ok) {
            this.store.replyStatus(
              reply.id,
              "failed",
              `Peer HTTP ${response.status}`,
            );
            continue;
          }
          this.store.replyStatus(reply.id, "sent");
        } catch (e) {
          this.store.replyStatus(reply.id, "uncertain", String(e));
        }
      }
    } finally {
      this.changed();
    }
  }
}
