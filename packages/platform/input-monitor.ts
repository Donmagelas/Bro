import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
export interface InputEvent {
  type: string;
  reason?: string;
  kind?: "key" | "pointer" | "move";
  pid?: number;
}
export class InputMonitor {
  private child?: ReturnType<typeof Bun.spawn>;
  private starting?: Promise<void>;
  private generation = 0;
  constructor(
    private root: string,
    private event: (event: InputEvent) => void,
  ) {}
  start() {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    const pending = this.launch(this.generation).finally(() => {
      if (this.starting === pending) this.starting = undefined;
    });
    return (this.starting = pending);
  }
  private async command() {
    let command: string[];
    if (process.platform === "darwin") {
      const source = join(import.meta.dir, "input-monitor.swift");
      const digest = createHash("sha256")
        .update(readFileSync(source))
        .digest("hex")
        .slice(0, 12);
      const bundled = join(import.meta.dir, "input-monitor-macos");
      const binary = existsSync(bundled)
        ? bundled
        : join(this.root, "bin", `input-monitor-macos-${digest}`);
      if (!existsSync(binary)) {
        mkdirSync(join(this.root, "bin"), { recursive: true });
        const compile = Bun.spawn(["xcrun", "swiftc", source, "-o", binary], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const error = await new Response(compile.stderr).text();
        if ((await compile.exited) !== 0) throw new Error(error);
      }
      command = [binary];
    } else if (process.platform === "win32")
      command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dir, "input-monitor.ps1"),
      ];
    else throw new Error("此平台没有输入监控实现");
    return command;
  }
  async permissions(permission?: string): Promise<Record<string, boolean>> {
    if (
      permission &&
      !["screen", "accessibility", "inputMonitoring"].includes(permission)
    )
      throw new Error("未知系统权限");
    const command = await this.command();
    command.push(
      ...(process.platform === "darwin"
        ? ["--permissions", permission || "check"]
        : ["-CheckOnly"]),
    );
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    // macOS may wait for the user to dismiss its native permission prompt.
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(error.trim() || "无法检查系统权限");
    return JSON.parse(output);
  }
  private async launch(generation: number) {
    const command = await this.command();
    if (generation !== this.generation) throw new Error("输入监控启动已取消");
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    this.child = child;
    return new Promise<void>((resolve, reject) => {
      let ready = false,
        failure = "";
      const current = () =>
        this.child === child && generation === this.generation;
      const unavailable = (reason: string) => {
        if (!current() || failure) return;
        failure = reason;
        this.event({ type: "unavailable", reason });
        reject(new Error(reason));
      };
      const timer = setTimeout(() => {
        unavailable("输入监控启动超时");
        child.kill();
      }, 10000);
      void (async () => {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          if (!current()) break;
          pending += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!line) continue;
            const event: InputEvent = JSON.parse(line);
            if (failure) continue;
            if (event.type === "ready") {
              ready = true;
              clearTimeout(timer);
              resolve();
            } else if (event.type === "unavailable") {
              clearTimeout(timer);
              unavailable(event.reason || "输入监控不可用");
              continue;
            }
            this.event(event);
          }
        }
      })().catch((e) => {
        unavailable(String(e));
        child.kill();
      });
      void new Response(child.stderr as ReadableStream<Uint8Array>)
        .text()
        .then((error) => {
          if (error) unavailable(error.slice(-1000));
        });
      void child.exited.then((code) => {
        clearTimeout(timer);
        if (current()) {
          unavailable(`输入监控已退出 (${code})`);
          this.child = undefined;
        }
        if (!ready) reject(new Error("输入监控未就绪，请检查系统权限"));
      });
    });
  }
  stop() {
    this.generation++;
    this.starting = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
