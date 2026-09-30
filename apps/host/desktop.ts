import { WorkspaceLocks } from "./locks";
import { InputMonitor } from "../../packages/platform/input-monitor";

const readMethods = new Set([
  "listDisplays",
  "listWindows",
  "capture",
  "axSnapshot",
  "axQuery",
  "axElementAt",
  "axFocused",
  "axNode",
  "axAttributes",
  "axChildren",
  "axParent",
]);
const inputMethods = new Set([
  "click",
  "moveMouse",
  "scroll",
  "typeText",
  "keyChord",
  "raiseWindow",
  "axPerform",
  "axSetValue",
  "axFocus",
  "axClick",
]);
export interface DesktopOperation {
  method: string;
  args?: any[];
}
export class Desktop {
  readonly state = {
    enabled: false,
    paused: false,
    owner: null as string | null,
    reason: "尚未启用",
    detectorReady: false,
    capabilities: null as any,
  };
  private locks = new WorkspaceLocks();
  private runs = new Map<string, Set<AbortController>>();
  private native: any;
  private monitor: InputMonitor;
  constructor(
    root: string,
    private changed: () => void,
    private nativeFactory?: () => Promise<any>,
  ) {
    this.monitor = new InputMonitor(root, (e) => this.inputEvent(e));
  }
  inputEvent(event: { type: string; reason?: string }) {
    if (event.type === "ready") {
      this.state.detectorReady = true;
      this.state.reason = "用户输入监控已连接";
    } else if (event.type === "unavailable") {
      this.state.detectorReady = false;
      this.state.paused = true;
      this.state.reason = event.reason || "输入监控不可用";
    } else if (event.type === "human" && this.state.owner) {
      this.state.paused = true;
      this.state.reason = "检测到用户键鼠输入，桌面操作已暂停";
    }
    this.changed();
  }
  async capabilities() {
    if (!this.native) {
      if (this.nativeFactory) this.native = await this.nativeFactory();
      else {
        const name = "@oh-my-pi/pi-natives/desktop";
        const { createDesktopSession } = await import(name);
        this.native = createDesktopSession({});
      }
    }
    this.state.capabilities = this.native.capabilities;
    return this.state;
  }
  async enable() {
    await this.capabilities();
    await this.monitor.start();
    this.state.enabled = true;
    this.state.paused = false;
    this.changed();
    return this.state;
  }
  disable() {
    this.state.enabled = false;
    this.state.paused = true;
    this.state.reason = "桌面操作已关闭";
    this.monitor.stop();
    this.state.detectorReady = false;
    this.changed();
  }
  resume() {
    if (!this.state.enabled || !this.state.detectorReady)
      throw new Error("先启用桌面操作并完成输入监控权限");
    this.state.paused = false;
    this.state.reason = "已手动继续；下一次操作应先读取当前界面";
    this.changed();
  }
  cancel(sessionId: string) {
    for (const controller of this.runs.get(sessionId) || []) controller.abort();
  }
  async execute(sessionId: string, operations: DesktopOperation[]) {
    if (
      !Array.isArray(operations) ||
      !operations.length ||
      operations.length > 32
    )
      throw new Error("每批需要 1–32 个桌面操作");
    if (!this.state.enabled || !this.state.detectorReady)
      throw new Error("桌面操作尚未启用或缺少输入监控权限");
    const controller = new AbortController();
    const active = this.runs.get(sessionId) || new Set<AbortController>();
    active.add(controller);
    this.runs.set(sessionId, active);
    let release: () => void;
    try {
      release = await this.locks.acquire("desktop", controller.signal);
    } catch (e) {
      active.delete(controller);
      throw e;
    }
    this.state.owner = sessionId;
    this.changed();
    const content: any[] = [];
    const guard = () => {
      controller.signal.throwIfAborted();
      if (this.state.paused || !this.state.enabled || !this.state.detectorReady)
        throw new Error(
          "桌面操作已暂停；需要用户在 GUI 手动继续后重新读取界面",
        );
    };
    try {
      await this.capabilities();
      for (const operation of operations) {
        guard();
        const method = operation.method,
          args = operation.args || [];
        if (!readMethods.has(method) && !inputMethods.has(method))
          throw new Error(`不支持的桌面动作 ${method}`);
        let result: any;
        if (method === "typeText") {
          const text = String(args[1] || "");
          if (text.length > 10000) throw new Error("单次输入最多 10000 字符");
          // Native calls cannot be recalled once posted. Bound each chunk and
          // check takeover before issuing the next chunk or batch operation.
          const chars = Array.from(text);
          for (let i = 0; i < chars.length; i += 16) {
            guard();
            await this.native.typeText(
              args[0],
              chars.slice(i, i + 16).join(""),
              args[2],
            );
          }
        } else if (method === "capture") {
          result = await this.native.capture(args[0] || "desktop", {
            maxWidth: 1280,
            maxHeight: 896,
          });
          content.push({
            type: "image",
            mimeType: "image/png",
            data: Buffer.from(result.data).toString("base64"),
          });
          result = { ...result, data: undefined };
        } else result = await this.native[method](...args);
        content.push({
          type: "text",
          text: JSON.stringify({ method, result: result ?? "完成" }),
        });
      }
      return { content, details: { sessionId } };
    } finally {
      active.delete(controller);
      if (!active.size) this.runs.delete(sessionId);
      this.state.owner = null;
      release();
      this.changed();
    }
  }
  async close() {
    this.disable();
    await this.native?.close();
  }
}
