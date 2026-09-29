import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export class InputMonitor {
  private child?: ReturnType<typeof Bun.spawn>;
  constructor(
    private root: string,
    private event: (event: { type: string; reason?: string }) => void,
  ) {}
  async start() {
    if (this.child) return;
    let command: string[];
    if (process.platform === "darwin") {
      const bundled = join(import.meta.dir, "input-monitor-macos");
      const binary = existsSync(bundled)
        ? bundled
        : join(this.root, "bin", "input-monitor-macos");
      if (!existsSync(binary)) {
        mkdirSync(join(this.root, "bin"), { recursive: true });
        const compile = Bun.spawn(
          [
            "xcrun",
            "swiftc",
            join(import.meta.dir, "input-monitor.swift"),
            "-o",
            binary,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
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
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    this.child = child;
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error("输入监控启动超时"));
        child.kill();
      }, 10000);
      void (async () => {
        let pending = "";
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          pending += new TextDecoder().decode(chunk);
          let end;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === "ready") {
              ready = true;
              clearTimeout(timer);
              resolve();
            } else if (event.type === "unavailable") {
              clearTimeout(timer);
              reject(new Error(event.reason));
            }
            this.event(event);
          }
        }
      })().catch((e) => {
        this.event({ type: "unavailable", reason: String(e) });
        reject(e);
      });
      void new Response(child.stderr as ReadableStream<Uint8Array>)
        .text()
        .then((error) => {
          if (error)
            this.event({ type: "unavailable", reason: error.slice(-1000) });
        });
      void child.exited.then((code) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = undefined;
          this.event({
            type: "unavailable",
            reason: `输入监控已退出 (${code})`,
          });
        }
        if (!ready) reject(new Error("输入监控未就绪，请检查系统权限"));
      });
    });
  }
  stop() {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
