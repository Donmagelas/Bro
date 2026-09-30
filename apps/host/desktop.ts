import { WorkspaceLocks } from "./locks";
import {
  InputMonitor,
  type InputEvent,
} from "../../packages/platform/input-monitor";

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
interface Target {
  id: string;
  pid: number;
  app: string;
  focused: boolean;
}
const quietMs = 1200;
const sustainedMs = 10000;
const humanInterruption = Symbol("human-interruption");
export class Desktop {
  readonly state = {
    enabled: false,
    paused: false,
    owner: null as string | null,
    reason: "尚未启用",
    detectorReady: false,
    capabilities: null as any,
    mode: "idle" as "idle" | "read" | "background" | "foreground" | "yielding",
    target: null as string | null,
    pausedApps: [] as string[],
  };
  private locks = new WorkspaceLocks();
  private runs = new Map<string, Set<AbortController>>();
  private native: any;
  private operation?: {
    mode: "read" | "background" | "foreground";
    target?: Target;
  };
  private pausedApps = new Map<number, string>();
  private globalPause = false;
  private pausedAt = 0;
  private recentInput?: { at: number; event: InputEvent };
  private recentApps = new Map<number, number>();
  private interruption?: { first: number; last: number };
  private observationsRequired = new Set<string>();
  private references = new Map<string, { sessionId: string; target: Target }>();
  private monitor: InputMonitor;
  constructor(
    root: string,
    private changed: () => void,
    private nativeFactory?: () => Promise<any>,
    private foregroundNotice: (message: string) => void = () => {},
  ) {
    this.monitor = new InputMonitor(root, (e) => this.inputEvent(e));
  }
  private updatePause() {
    this.state.pausedApps = [...this.pausedApps.values()];
    this.state.paused = this.globalPause || this.pausedApps.size > 0;
  }
  private conflict(event: InputEvent) {
    const op = this.operation;
    if (!op || op.mode === "read") return false;
    if (op.mode === "foreground") return true;
    return (
      event.kind !== "move" && (!event.pid || event.pid === op.target?.pid)
    );
  }
  private takeover() {
    this.pausedAt = Date.now();
    if (this.operation?.mode === "background" && this.operation.target) {
      const { pid, app } = this.operation.target;
      this.pausedApps.set(pid, app);
      this.state.reason = `Computer Use 已暂停（${app}）；准备好后在对话中告诉我“继续”`;
    } else {
      this.globalPause = true;
      this.state.reason = "Computer Use 已暂停；准备好后在对话中告诉我“继续”";
    }
    this.updatePause();
    this.changed();
  }
  private yieldToHuman() {
    const now = Date.now();
    if (!this.interruption) {
      this.interruption = { first: now, last: now };
      this.state.mode = "yielding";
      this.state.reason = `正在让路：${this.operation?.target?.app || "前台键鼠"}；停手后会重新查看界面并继续`;
      this.changed();
    } else {
      if (now - this.interruption.last >= quietMs)
        this.interruption.first = now;
      this.interruption.last = now;
      if (now - this.interruption.first >= sustainedMs) this.takeover();
    }
  }
  inputEvent(event: InputEvent) {
    if (event.type === "human") {
      this.recentInput = { at: Date.now(), event };
      if (event.kind !== "move" && event.pid) {
        this.recentApps.set(event.pid, Date.now());
        for (const [pid, at] of this.recentApps)
          if (Date.now() - at > 1000) this.recentApps.delete(pid);
      }
      if (this.conflict(event)) {
        // Unknown attribution cannot establish a safe application-scoped yield.
        if (this.operation?.mode === "background" && !event.pid)
          this.takeover();
        else this.yieldToHuman();
      }
      return;
    }
    if (!this.state.enabled) return;
    if (event.type === "ready") {
      this.state.detectorReady = true;
      if (!this.state.paused)
        this.state.reason = "后台操作已就绪；短暂操作时让路，持续操作时暂停";
    } else if (event.type === "unavailable") {
      this.state.detectorReady = false;
      this.state.reason =
        (event.reason || "输入监控不可用") + "；仍可尝试截图和读取界面";
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
  async refresh() {
    if (this.state.owner) throw new Error("请等待当前桌面操作结束后再检测权限");
    const release = await this.locks.acquire("desktop");
    try {
      await this.native?.close();
      this.native = undefined;
      this.references.clear();
      await this.capabilities();
      if (this.state.enabled) await this.enable();
      this.changed();
      return this.state;
    } finally {
      release();
    }
  }
  async enable() {
    await this.capabilities();
    if (!this.state.enabled) {
      this.globalPause = false;
      this.pausedApps.clear();
      this.updatePause();
    }
    this.state.enabled = true;
    // Input monitoring is required only for writes, never for read-only work.
    try {
      await this.monitor.start();
    } catch (error) {
      this.inputEvent({ type: "unavailable", reason: String(error) });
    }
    this.changed();
    return this.state;
  }
  async permissions(permission?: string) {
    await this.refresh();
    const permissions = await this.monitor.permissions(permission);
    if (permission) await this.refresh();
    if (process.platform === "win32") {
      permissions.screen = !!this.state.capabilities?.capture;
      permissions.accessibility =
        !!this.state.capabilities?.ax && !!this.state.capabilities?.input;
    }
    const capabilities = this.state.capabilities;
    const restartRequired =
      process.platform === "darwin" &&
      permissions.screen &&
      permissions.accessibility &&
      permissions.inputMonitoring &&
      (!capabilities?.capture || !capabilities?.input || !capabilities?.ax);
    return {
      platform: process.platform,
      permissions,
      restartRequired: !!restartRequired,
    };
  }
  disable() {
    this.state.enabled = false;
    this.globalPause = true;
    this.updatePause();
    this.state.reason = "桌面操作已关闭";
    for (const runs of this.runs.values()) for (const run of runs) run.abort();
    this.monitor.stop();
    this.state.detectorReady = false;
    this.changed();
  }
  pause() {
    this.pausedAt = Date.now();
    this.globalPause = true;
    this.updatePause();
    this.state.reason =
      "Computer Use 已暂停；准备好后在对话中告诉我“继续”。仍可截图和读取界面";
    this.changed();
  }
  resume() {
    if (!this.state.enabled || !this.state.detectorReady)
      throw new Error("先启用桌面操作并完成输入监控权限");
    this.globalPause = false;
    this.pausedApps.clear();
    this.recentInput = undefined;
    this.recentApps.clear();
    // Do not reuse element references acquired before human takeover.
    this.references.clear();
    this.updatePause();
    this.state.reason = "已继续；下一次操作应先读取当前界面";
    this.changed();
  }
  resumeFromMessage(createdAt: number, source: string) {
    if (
      this.state.paused &&
      (createdAt <= this.pausedAt ||
        !["gui", "feishu", "peer"].includes(source))
    )
      throw new Error(
        "Computer Use 已暂停；需要用户在暂停后发来新的继续指令，当前任务不能自行解除暂停",
      );
    this.resume();
    return {
      resumed: true,
      instruction:
        "先重新截图或读取目标窗口，确认当前状态后继续原任务；不要重放旧批次。",
    };
  }
  private async target(
    sessionId: string,
    method: string,
    args: any[],
  ): Promise<Target | undefined> {
    if (
      ["capture", "listWindows", "listDisplays", "axFocused"].includes(method)
    )
      return;
    const refMethod = [
      "axNode",
      "axAttributes",
      "axChildren",
      "axParent",
      "axPerform",
      "axSetValue",
      "axFocus",
      "axClick",
    ].includes(method);
    const reference = refMethod ? this.references.get(args[0]) : undefined;
    if (refMethod && reference?.sessionId !== sessionId) return;
    const id = refMethod ? reference?.target.id : args[0];
    if (!id || id === "desktop" || method === "axFocused") return;
    const windows = await this.native.listWindows();
    const window = windows.find((w: any) => w.id === id);
    if (!window?.pid || (reference && reference.target.pid !== window.pid))
      return;
    return {
      id,
      pid: window.pid,
      app: window.app || window.title || "目标应用",
      focused: windows.some((w: any) => w.pid === window.pid && w.focused),
    };
  }
  private remember(sessionId: string, result: any, target?: Target) {
    if (!target || !result) return;
    const refs: string[] = [];
    if (typeof result.text === "string")
      for (const match of result.text.matchAll(/\[ref=([^\]\s]+)\]/g))
        refs.push(match[1]);
    for (const node of Array.isArray(result) ? result : [result])
      if (typeof node?.ref === "string") refs.push(node.ref);
    for (const ref of refs) this.references.set(ref, { sessionId, target });
    // Native references remain opaque and are only associated with observed windows.
    while (this.references.size > 10000)
      this.references.delete(this.references.keys().next().value!);
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
    if (!this.state.enabled) throw new Error("桌面操作尚未启用");
    for (const op of operations)
      if (!readMethods.has(op.method) && !inputMethods.has(op.method))
        throw new Error(`不支持的桌面动作 ${op.method}`);
    const controller = new AbortController();
    const active = this.runs.get(sessionId) || new Set<AbortController>();
    active.add(controller);
    this.runs.set(sessionId, active);
    let release: () => void;
    try {
      release = await this.locks.acquire("desktop", controller.signal);
    } catch (e) {
      active.delete(controller);
      if (!active.size) this.runs.delete(sessionId);
      throw e;
    }
    this.state.owner = sessionId;
    this.changed();
    const content: any[] = [];
    let completedOperations = 0;
    let inputMayBePartial = false;
    const checkFocus = async () => {
      const op = this.operation;
      if (
        this.interruption ||
        op?.mode !== "background" ||
        !op.target ||
        op.target.focused
      )
        return;
      const focused = (await this.native.listWindows()).find(
        (w: any) => w.focused,
      );
      if (focused?.pid === op.target.pid) {
        this.pausedAt = Date.now();
        this.globalPause = true;
        this.updatePause();
        this.state.reason = `${op.target.app} 自行切到了前台，Computer Use 已暂停；准备好后在对话中告诉我“继续”`;
        this.changed();
      }
    };
    const guard = () => {
      controller.signal.throwIfAborted();
      if (!this.state.enabled) throw new Error("桌面操作已关闭");
      if (this.operation?.mode !== "read") {
        if (!this.state.detectorReady)
          throw new Error("缺少输入监控权限，暂不能输入；仍可截图和读取界面");
        if (this.interruption) throw humanInterruption;
        if (
          this.globalPause ||
          (this.operation?.mode === "foreground" && this.pausedApps.size) ||
          (this.operation?.target &&
            this.pausedApps.has(this.operation.target.pid))
        )
          throw new Error(
            "Computer Use 已暂停；请直接回复用户：准备好后告诉我继续。收到新的继续指令后调用 resume:true，再重新读取界面",
          );
      }
    };
    try {
      await this.capabilities();
      let foregroundAnnounced = false;
      for (const operation of operations) {
        inputMayBePartial = false;
        const method = operation.method,
          args = operation.args || [];
        const reading = readMethods.has(method);
        // Stop attribution of human activity to the preceding operation while resolving this one.
        this.operation = { mode: "read" };
        guard();
        const target = await this.target(sessionId, method, args);
        const foreground =
          !reading &&
          (args[0] === "desktop" ||
            method === "raiseWindow" ||
            method === "axFocus" ||
            (method === "axPerform" && /raise|focus/i.test(String(args[1]))) ||
            args.some(
              (arg) => arg && typeof arg === "object" && arg.takeover === true,
            ));
        if (!reading && !target && args[0] !== "desktop")
          throw new Error(
            "无法确认目标应用；请先 listWindows 并针对窗口重新读取 AX，再执行输入",
          );
        if (
          !reading &&
          !foreground &&
          !method.startsWith("ax") &&
          !this.state.capabilities?.backgroundWindowInput
        )
          throw new Error(
            "BackgroundUnavailable：当前后端不支持后台窗口输入；需要前台操作时显式设置 takeover:true",
          );
        this.operation = {
          mode: reading ? "read" : foreground ? "foreground" : "background",
          target,
        };
        this.state.mode = this.operation.mode;
        this.state.target = target?.app || (reading ? null : "桌面");
        this.changed();
        guard();
        if (!reading) {
          // Catch typing that began just before the operation, not only events during it.
          const recent = this.recentInput;
          if (
            (target &&
              Date.now() - (this.recentApps.get(target.pid) || 0) < 750) ||
            (recent &&
              Date.now() - recent.at < 750 &&
              this.conflict(recent.event))
          )
            this.yieldToHuman();
        }
        guard();
        const observationKey = `${sessionId}\0${target?.id || args[0] || "desktop"}`;
        if (!reading && this.observationsRequired.has(observationKey))
          throw new Error(
            "人工操作改变了界面；请先对该窗口 capture/axSnapshot/axQuery 重新观察，再决定后续输入。不要重放上一批动作。",
          );
        if (foreground && !foregroundAnnounced) {
          this.foregroundNotice(
            `Bro 即将短暂操作前台：${this.state.target}。你操作时会先让路，持续操作才暂停。`,
          );
          foregroundAnnounced = true;
          // Publish the status/notification before the native call; this is not an approval gate.
          await Bun.sleep(1000);
          guard();
        }
        let result: any;
        if (method === "typeText") {
          const text = String(args[1] || "");
          if (text.length > 10000) throw new Error("单次输入最多 10000 字符");
          // Native calls cannot be recalled once posted. Bound each chunk and
          // check takeover before issuing the next chunk or batch operation.
          const chars = Array.from(text);
          for (let i = 0; i < chars.length; i += 16) {
            guard();
            inputMayBePartial = true;
            await this.native.typeText(
              args[0],
              chars.slice(i, i + 16).join(""),
              args[2],
            );
            await Bun.sleep(0);
            await checkFocus();
            guard();
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
        } else {
          inputMayBePartial = !reading;
          result = await this.native[method](...args);
        }
        if (
          ["capture", "axSnapshot", "axQuery", "axElementAt"].includes(method)
        )
          this.observationsRequired.delete(observationKey);
        this.remember(sessionId, result, target);
        // Drain the input-monitor pipe before reporting success or issuing another operation.
        if (!reading) {
          await Bun.sleep(0);
          await checkFocus();
          guard();
        }
        content.push({
          type: "text",
          text: JSON.stringify({ method, result: result ?? "完成" }),
        });
        completedOperations++;
      }
      return { content, details: { sessionId } };
    } catch (error) {
      if (error !== humanInterruption) throw error;
      const target = this.operation?.target;
      this.observationsRequired.add(`${sessionId}\0${target?.id || "desktop"}`);
      this.references.clear();
      // The old batch is abandoned immediately, never resumed or replayed.
      // Keep observing human activity while waiting for a quiet interval.
      const isPaused = () =>
        this.globalPause ||
        (this.operation?.mode === "foreground" && this.pausedApps.size > 0) ||
        !!(target && this.pausedApps.has(target.pid));
      while (!isPaused()) {
        controller.signal.throwIfAborted();
        if (!this.state.enabled) throw new Error("桌面操作已关闭");
        if (!this.state.detectorReady)
          throw new Error("输入监控不可用；请恢复权限后重新观察界面");
        if (Date.now() - this.interruption!.last >= quietMs) break;
        await Bun.sleep(50);
      }
      const requiresManualResume = isPaused();
      const instruction = requiresManualResume
        ? "用户持续操作或主动暂停：停止该目标的输入，立即在对话中回复：Computer Use 已暂停，准备好后告诉我继续。收到用户新的继续指令后调用 resume:true，再重新观察界面，不要重放被打断的动作。"
        : "用户短暂操作已结束：无需询问或等待手动继续。请立即对目标窗口重新截图/读取 AX，检查已产生的输入和当前状态，再继续原任务。不要重放上一批动作或盲目补发剩余文字。";
      if (!requiresManualResume)
        this.state.reason = "已让路；正在重新观察界面后继续任务";
      content.push({
        type: "text",
        text: JSON.stringify({
          interrupted: true,
          completedOperations,
          inputMayBePartial,
          requiresManualResume,
          instruction,
        }),
      });
      return {
        content,
        details: { sessionId, interrupted: true, requiresManualResume },
      };
    } finally {
      active.delete(controller);
      if (!active.size) this.runs.delete(sessionId);
      this.operation = undefined;
      this.interruption = undefined;
      this.state.mode = "idle";
      this.state.target = null;
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
