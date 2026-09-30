import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  basename,
  extname,
  isAbsolute,
  join,
  resolve,
  relative,
} from "node:path";
import {
  existsSync,
  mkdirSync,
  statSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { Store } from "./store";
import { Runtimes } from "./runtime";
import { AccountAuth } from "./auth";
import { Resources } from "./resources";
import { Desktop } from "./desktop";
import { Feishu, type FeishuConfig } from "../../packages/integrations/feishu";
import { Monitor } from "../../packages/integrations/monitor";
import {
  VERSION,
  type Connection,
  type RuntimeEvent,
  type Subscription,
  type Input,
  type Settings,
  type Thinking,
} from "../../packages/contracts";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const str = (value: unknown, name: string, max = 1000000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name}不能为空或超出长度限制`);
  return value;
};
const obj = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("需要 JSON 对象");
  return v as Record<string, any>;
};
const allowed = (v: string, values: string[], name: string) => {
  if (!values.includes(v)) throw new Error(`${name}不支持 ${v}`);
  return v;
};

export function createHost(
  root: string,
  token: string,
  options: { port?: number; runtimeFactory?: typeof Runtimes } = {},
) {
  const store = new Store(root);
  store.recover();
  let version = 0;
  let closing = false;
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: RuntimeEvent) => {
    for (const listener of listeners) listener({ id: ++version, ...event });
  };
  const changed = () => {
    for (const listener of listeners)
      listener({ id: ++version, type: "state" });
  };
  const runtimes = new (options.runtimeFactory || Runtimes)(
    store,
    emit,
    changed,
    () => {
      void feishu.flush();
      void monitor.flush();
    },
  );
  const feishu = new Feishu(store, changed, (id) => runtimes.wake(id));
  const monitor = new Monitor(store, (id) => runtimes.wake(id), changed);
  const desktop = new Desktop(root, changed, undefined, (message) => {
    for (const listener of listeners)
      listener({ id: ++version, type: "desktop_notice", message });
  });
  runtimes.beforeStop = (id) => desktop.cancel(id);
  const oauth = new AccountAuth(store, changed);
  const resources = new Resources(store, () => runtimes.refresh());
  const state = () => {
    const savedFeishu = store.getConfig<FeishuConfig | null>("feishu", null);
    return {
      version: VERSION,
      sessions: store.sessions(),
      archivedSessions: store.sessions(true).filter((s) => s.archived),
      projects: store.projects(),
      connections: store.connections(),
      settings: store.getSettings(),
      delegations: store.delegations(),
      subscriptions: store.subscriptions(),
      feishu: {
        ...feishu.status,
        configured: !!savedFeishu,
        enabled: savedFeishu?.enabled === true,
        appId: savedFeishu?.appId,
        botId: savedFeishu?.botId,
      },
      desktop: desktop.state,
      monitorErrors: Object.fromEntries(monitor.errors),
      bindings: store.bindings(),
      resources: resources.publicList(),
      runtimeInfo: Object.fromEntries(
        store
          .sessions()
          .map((s) => [s.id, store.getConfig(`runtimeInfo:${s.id}`, null)]),
      ),
      pendingRefresh: runtimes.pendingRefresh,
    };
  };
  const authorized = (request: Request) => {
    const supplied =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    const a = Buffer.from(supplied),
      b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  runtimes.hostCall = async (sessionId, inputId, action, args) => {
    const input = store.input(inputId);
    if (!input || input.sessionId !== sessionId)
      throw new Error("无有效任务来源");
    if (action === "bro_computer") {
      if (args.resume)
        return desktop.resumeFromMessage(input.createdAt, input.source.kind);
      return args.capabilities
        ? desktop.capabilities()
        : desktop.execute(sessionId, args.operations);
    }
    if (action === "bro_sessions")
      return store
        .sessions()
        .filter((s) => !args.query || s.title.includes(args.query))
        .map(({ id, title, cwd, status, queued }) => ({
          id,
          title,
          cwd,
          status,
          queued,
        }));
    if (action === "bro_read_session")
      return (await runtimes.history(str(args.sessionId, "会话 ID"))).slice(
        -30,
      );
    if (action === "bro_send_session") {
      const d = store.delegate(
        sessionId,
        str(args.sessionId, "会话 ID"),
        inputId,
        str(args.text, "交办内容"),
      );
      runtimes.wake(d.targetSessionId);
      changed();
      return {
        id: d.id,
        status: "queued",
        message: "已进入目标会话队列，完成后返回来源会话。",
      };
    }
    if (action === "bro_stop_session") {
      await runtimes.stop(str(args.sessionId, "会话 ID"));
      return { stopped: true };
    }
    if (action === "bro_group_history") {
      if (
        input.source.kind !== "feishu" ||
        input.source.chatType !== "group" ||
        !input.source.chatId
      )
        throw new Error("当前请求没有飞书群来源");
      return feishu.history(input.source.chatId);
    }
    throw new Error("未知跨会话操作");
  };
  async function body(request: Request) {
    const text = await request.text();
    if (text.length > 2_000_000) throw new Error("请求过大");
    return obj(JSON.parse(text || "{}"));
  }
  function ensurePath(path: string) {
    const p = resolve(path);
    if (!existsSync(p) || !statSync(p).isDirectory())
      throw new Error("工作目录不存在");
    return p;
  }
  function validateConnection(data: Record<string, any>): Connection {
    const kind = allowed(
      str(data.kind, "类型"),
      ["api", "chatgpt"],
      "连接类型",
    ) as Connection["kind"];
    const id = typeof data.id === "string" ? data.id : randomUUID();
    let baseUrl: string | undefined;
    if (kind === "api") {
      const url = new URL(str(data.baseUrl, "Base URL"));
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Base URL 需要 HTTP(S)");
      baseUrl = url.href.replace(/\/$/, "");
    }
    return {
      id,
      name: str(data.name, "连接名称", 100),
      kind,
      provider: kind === "chatgpt" ? "openai-codex" : `bro-${id}`,
      model: str(data.model, "模型 ID", 200),
      baseUrl,
      api:
        kind === "api"
          ? (allowed(
              data.api || "openai-completions",
              ["openai-completions", "openai-responses", "anthropic-messages"],
              "协议",
            ) as Connection["api"])
          : undefined,
      contextWindow: Math.max(
        4096,
        Math.min(Number(data.contextWindow) || 128000, 2000000),
      ),
      maxTokens: Math.max(
        1024,
        Math.min(Number(data.maxTokens) || 16384, 128000),
      ),
      reasoning: !!data.reasoning,
      imageInput: !!data.imageInput,
    };
  }
  async function modelSelection(
    update: {
      connectionId?: string;
      model?: string | null;
      thinking?: Thinking;
    },
    previous: {
      connectionId: string | null;
      model?: string | null;
      thinking: Thinking;
    },
  ) {
    const connectionId = update.connectionId ?? previous.connectionId;
    if (!connectionId) {
      if (update.model || update.thinking) throw new Error("请先选择模型连接");
      return { connectionId: null, model: null, thinking: previous.thinking };
    }
    const connection = store.connection(connectionId);
    if (!connection) throw new Error("连接不存在");
    const modelId =
      update.model ||
      (connectionId === previous.connectionId ? previous.model : null) ||
      connection.model;
    const model = (await oauth.models(connection)).find(
      (m) => m.id === modelId,
    );
    if (!model) throw new Error(`模型不可用：${modelId}。请重新选择模型。`);
    const levels = model.thinkingLevels.length ? model.thinkingLevels : ["off"];
    if (update.thinking !== undefined && !levels.includes(update.thinking))
      throw new Error("该模型不支持所选思考强度");
    const thinking =
      update.thinking ??
      (levels.includes(previous.thinking)
        ? previous.thinking
        : model.defaultThinking);
    return {
      connectionId,
      model: connection.kind === "chatgpt" ? model.id : null,
      thinking,
    };
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 120,
    maxRequestBodySize: 30 * 1024 * 1024,
    async fetch(request) {
      if (closing) return json({ error: "后台正在退出" }, 503);
      if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url),
        path = url.pathname,
        method = request.method;
      try {
        if (path === "/health") return json({ ok: true, version: VERSION });
        if (path === "/state" && method === "GET") return json(state());
        if (path === "/auth/status" && method === "GET")
          return json(await oauth.status());
        if (path === "/auth/quota" && method === "GET") {
          const connection = store.connection(
            url.searchParams.get("connectionId") || "",
          );
          if (connection?.kind !== "chatgpt")
            return json({ error: "请使用 ChatGPT 账号连接" }, 400);
          return json(
            await oauth.quota(url.searchParams.get("refresh") === "1"),
          );
        }
        if (path === "/models" && method === "GET")
          return json(
            (
              await Promise.all(store.connections().map((c) => oauth.models(c)))
            ).flat(),
          );
        if (path === "/auth/login" && method === "POST")
          return json(await oauth.start());
        if (path === "/auth/answer" && method === "POST") {
          oauth.submit(str((await body(request)).value, "授权信息"));
          return json({ ok: true });
        }
        if (path === "/auth/cancel" && method === "POST") {
          oauth.cancel();
          return json({ ok: true });
        }
        if (path === "/auth/logout" && method === "POST") {
          await oauth.logout();
          return json({ ok: true });
        }
        if (path === "/events" && method === "GET") {
          let cleanup = () => {};
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const push = (event: unknown) => {
                try {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                  );
                } catch {
                  cleanup();
                }
              };
              const timer = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(": keepalive\n\n"));
                } catch {
                  cleanup();
                }
              }, 20000);
              cleanup = () => {
                listeners.delete(push);
                clearInterval(timer);
              };
              listeners.add(push);
              request.signal.addEventListener(
                "abort",
                () => {
                  cleanup();
                  try {
                    controller.close();
                  } catch {}
                },
                { once: true },
              );
              push({ type: "state" });
            },
            cancel() {
              cleanup();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        }
        if (path === "/projects" && method === "POST") {
          const b = await body(request);
          const p = ensurePath(str(b.path, "目录"));
          const result = store.addProject(b.name || basename(p), p);
          changed();
          return json(result);
        }
        const projectMatch = path.match(/^\/projects\/([^/]+)$/);
        if (projectMatch) {
          const id = decodeURIComponent(projectMatch[1]!);
          if (!store.projects().some((p) => p.id === id))
            return json({ error: "项目不存在" }, 404);
          if (method === "PATCH") {
            const b = await body(request);
            if (b.archived !== undefined && typeof b.archived !== "boolean")
              throw new Error("归档状态需要布尔值");
            store.updateProject(id, {
              name:
                b.name === undefined ? undefined : str(b.name, "项目名称", 200),
              archived: b.archived,
            });
            changed();
            return json(store.projects().find((p) => p.id === id));
          }
          if (method === "DELETE") {
            store.deleteProject(id);
            await runtimes.refresh();
            changed();
            return json({ ok: true });
          }
        }
        if (path === "/sessions" && method === "POST") {
          const b = await body(request);
          const project = b.projectId
            ? store.projects().find((p) => p.id === b.projectId)
            : undefined;
          if (b.projectId && !project) throw new Error("项目不存在");
          const defaults = store.getSettings();
          const selection = await modelSelection(b, {
            connectionId: defaults.defaultConnectionId,
            model: defaults.defaultModel,
            thinking: defaults.defaultThinking || "medium",
          });
          const result = store.createSession({
            title: b.title,
            cwd: project?.path,
            projectId: project?.id,
            ...selection,
          });
          changed();
          return json(result);
        }
        const match = path.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
        if (match) {
          const id = decodeURIComponent(match[1]!),
            action = match[2];
          const session = store.session(id);
          if (!session) return json({ error: "会话不存在" }, 404);
          if (!action && method === "PATCH") {
            const b = await body(request);
            const update: Record<string, any> = {};
            if (b.title !== undefined) update.title = str(b.title, "标题", 200);
            if (b.pinned !== undefined) update.pinned = !!b.pinned;
            if (b.archived !== undefined) update.archived = !!b.archived;
            if (
              b.connectionId !== undefined ||
              b.model !== undefined ||
              b.thinking !== undefined
            ) {
              Object.assign(
                update,
                await modelSelection(b, {
                  ...session,
                  connectionId:
                    session.connectionId ||
                    store.getSettings().defaultConnectionId,
                }),
              );
              runtimes.configure(id, update);
            } else store.updateSession(id, update);
            changed();
            return json(store.session(id));
          }
          if (!action && method === "DELETE") {
            await runtimes.release(id, () => store.deleteSession(id));
            changed();
            return json({ ok: true });
          }
          if (action === "history" && method === "GET") {
            const history = session.runtimeFile
              ? await runtimes.history(id)
              : [];
            return json({ messages: history, inputs: store.inputs(id) });
          }
          if (action === "compact" && method === "POST")
            return json(await runtimes.compact(id));
          if (action === "stats" && method === "GET")
            return json(await runtimes.stats(id));
          if (action === "memory" && method === "POST") {
            const b = await body(request);
            return json(
              await runtimes.memory(
                id,
                b.query === undefined
                  ? undefined
                  : str(b.query, "搜索内容", 4000),
              ),
            );
          }
          if (action === "diff" && method === "GET") {
            const run = async (args: string[]) => {
              const child = Bun.spawn(["git", "-C", session.cwd, ...args], {
                stdout: "pipe",
                stderr: "pipe",
              });
              let text = "";
              const consume = (async () => {
                for await (const chunk of child.stdout) {
                  text += new TextDecoder().decode(chunk);
                  if (text.length > 1000000) {
                    child.kill();
                    throw new Error("Diff 过大，请在终端按文件查看");
                  }
                }
              })();
              const error = await new Response(child.stderr).text();
              await consume;
              if ((await child.exited) !== 0)
                throw new Error(error || "当前目录不是 Git 仓库");
              return text;
            };
            return json({
              unstaged: await run(["diff", "--no-ext-diff", "--no-color"]),
              staged: await run([
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-color",
              ]),
              status: await run(["status", "--short"]),
            });
          }
          if (action === "messages" && method === "POST") {
            const b = await body(request);
            const text = str(b.text, "消息");
            const mode = b.mode || "queue";
            allowed(mode, ["queue", "steer"], "发送方式");
            const extra: Partial<Input> = {
              id: typeof b.id === "string" ? b.id : randomUUID(),
            };
            if (b.attachments) {
              if (!Array.isArray(b.attachments) || b.attachments.length > 20)
                throw new Error("附件过多");
              extra.attachments = b.attachments.map((a: any) => {
                const p = resolve(str(a.path, "附件路径")),
                  rel = relative(join(root, "attachments"), p);
                if (
                  !rel ||
                  rel.startsWith("..") ||
                  isAbsolute(rel) ||
                  !existsSync(p)
                )
                  throw new Error("无效附件");
                return {
                  path: p,
                  name: str(a.name, "文件名"),
                  mimeType: str(a.mimeType, "文件类型"),
                };
              });
            }
            if (b.annotations) {
              if (!Array.isArray(b.annotations))
                throw new Error("批注格式错误");
              extra.annotations = b.annotations.map((a: any) => ({
                messageId: str(a.messageId, "消息 ID"),
                quote: str(a.quote, "原文"),
                comment: str(a.comment, "批注意见"),
              }));
            }
            if (mode === "steer") {
              await runtimes.steer(id, {
                ...extra,
                text,
                source: { kind: "gui" },
              });
              return json({ steered: true });
            }
            if (session.status === "interrupted")
              store.updateSession(id, { status: "idle", error: null });
            const input = store.enqueue(id, text, { kind: "gui" }, extra);
            runtimes.wake(id);
            changed();
            return json(input, 202);
          }
          if (action === "stop" && method === "POST") {
            await runtimes.stop(id);
            changed();
            return json({ ok: true });
          }
          if (action === "resume" && method === "POST") {
            store.updateSession(id, { status: "idle", error: null });
            runtimes.wake(id);
            changed();
            return json({ ok: true });
          }
          if (action === "delegate" && method === "POST") {
            const b = await body(request);
            const origin = store.enqueue(
              id,
              `交办：${str(b.text, "交办内容")}`,
              { kind: "gui" },
            );
            store.finishInput(origin.id, "completed");
            const d = store.delegate(
              id,
              str(b.targetSessionId, "目标会话"),
              origin.id,
              b.text,
            );
            runtimes.wake(d.targetSessionId);
            changed();
            return json(d);
          }
          if (action === "fork" && method === "POST") {
            const messageId = str(
              (await body(request)).messageId,
              "回复 ID",
              200,
            );
            if (!session.runtimeFile) throw new Error("会话还没有可分支的历史");
            const packageName = "@oh-my-pi/pi-coding-agent";
            const { SessionManager, copySessionArtifacts } = await import(
              packageName
            );
            const fork = store.createSession({
              ...session,
              title: `${session.title} · 分支`,
            });
            const dir = join(root, "sessions", fork.id);
            try {
              const manager = await SessionManager.open(
                session.runtimeFile,
                dir,
                undefined,
                {
                  throwIfMissing: true,
                  suppressBreadcrumb: true,
                },
              );
              try {
                const entry = manager
                  .getBranch()
                  .find((e: any) => e.id === messageId);
                if (
                  entry?.type !== "message" ||
                  entry.message.role !== "assistant"
                )
                  throw new Error("只能从当前会话已保存的回复创建分支");
                // A reply can include planned tool calls. Their results occur
                // after the selected boundary, so carry only the reply content.
                if (Array.isArray(entry.message.content)) {
                  entry.message.content = entry.message.content.filter(
                    (c: any) => c.type !== "toolCall",
                  );
                  if (entry.message.stopReason === "toolUse")
                    entry.message.stopReason = "stop";
                }
                mkdirSync(dir, { recursive: true });
                const runtimeFile = manager.createBranchedSession(messageId);
                if (!runtimeFile) throw new Error("分支历史保存失败");
                await copySessionArtifacts(session.runtimeFile, runtimeFile);
                store.updateSession(fork.id, { runtimeFile });
              } finally {
                await manager.close();
              }
              store.setConfig(`memoryScope:${fork.id}`, store.memoryScope(id));
            } catch (error) {
              store.deleteSession(fork.id);
              rmSync(dir, { recursive: true, force: true });
              throw error;
            }
            changed();
            return json(store.session(fork.id));
          }
        }
        if (path === "/connections" && method === "POST") {
          const b = await body(request);
          const c = validateConnection(b);
          if (c.kind === "api" && !b.apiKey && !store.connection(c.id)?.apiKey)
            throw new Error("请填写 API Key");
          store.saveConnection(c, b.apiKey || undefined);
          await runtimes.refresh();
          const settings = store.getSettings();
          if (!settings.defaultConnectionId) {
            settings.defaultConnectionId = c.id;
            store.setConfig("settings", settings);
          }
          changed();
          runtimes.wakeAll();
          return json(c);
        }
        const connectionMatch = path.match(/^\/connections\/([^/]+)$/);
        if (connectionMatch && method === "DELETE") {
          const id = connectionMatch[1]!;
          if (!store.connection(id)) throw new Error("连接不存在");
          const busy = store
            .sessions()
            .some(
              (s) =>
                (s.connectionId === id ||
                  (!s.connectionId &&
                    store.getSettings().defaultConnectionId === id)) &&
                ["starting", "waiting", "running"].includes(s.status),
            );
          if (busy) throw new Error("该连接仍有运行中的会话，请结束后再删除");
          store.deleteConnection(id);
          await runtimes.refresh();
          changed();
          return json({ removed: true });
        }
        if (path === "/settings" && method === "PATCH") {
          const b = await body(request),
            settings = store.getSettings();
          if (b.defaultCwd !== undefined)
            settings.defaultCwd = ensurePath(str(b.defaultCwd, "默认工作目录"));
          if (
            b.defaultConnectionId !== undefined ||
            b.defaultModel !== undefined ||
            b.defaultThinking !== undefined
          ) {
            const selection = await modelSelection(
              {
                connectionId: b.defaultConnectionId,
                model: b.defaultModel,
                thinking: b.defaultThinking,
              },
              {
                connectionId: settings.defaultConnectionId,
                model: settings.defaultModel,
                thinking: settings.defaultThinking || "medium",
              },
            );
            settings.defaultConnectionId = selection.connectionId;
            settings.defaultModel = selection.model;
            settings.defaultThinking = selection.thinking;
          }
          if (b.trustedFeishuUsers !== undefined) {
            if (
              !Array.isArray(b.trustedFeishuUsers) ||
              b.trustedFeishuUsers.some(
                (x: any) => typeof x !== "string" || !x.startsWith("ou_"),
              )
            )
              throw new Error("请输入飞书 open_id（ou_ 开头）");
            settings.trustedFeishuUsers = [
              ...new Set(b.trustedFeishuUsers),
            ] as string[];
          }
          if (b.memory !== undefined) settings.memory = !!b.memory;
          if (b.computer !== undefined) {
            if (b.computer) await desktop.enable();
            else desktop.disable();
            settings.computer = !!b.computer;
          }
          if (b.experiments) {
            const e = obj(b.experiments);
            for (const stage of ["skills", "context", "compression"] as const)
              if (e[stage] !== undefined)
                settings.experiments[stage] = allowed(
                  e[stage],
                  ["normal", "shadow", "experimental"],
                  "实验模式",
                ) as any;
            if (e.backend !== undefined)
              settings.experiments.backend = allowed(
                e.backend,
                ["typesafe", "laya"],
                "实验后端",
              ) as any;
            if (e.endpoint !== undefined) {
              if (e.endpoint && !/^https?:\/\//.test(e.endpoint))
                throw new Error("判断接口需要 HTTP(S)");
              settings.experiments.endpoint = e.endpoint;
            }
            if (e.model !== undefined)
              settings.experiments.model = String(e.model);
          }
          if (b.experimentKey !== undefined)
            store.setConfig("experimentKey", String(b.experimentKey));
          store.setConfig("settings", settings);
          if (
            b.memory !== undefined ||
            b.experiments ||
            b.experimentKey !== undefined
          )
            await runtimes.refresh();
          changed();
          runtimes.wakeAll();
          return json(settings);
        }
        if (path === "/desktop" && method === "GET")
          return json(await desktop.refresh());
        if (path === "/desktop/permissions" && method === "POST") {
          const b = await body(request);
          if (
            b.permission !== undefined &&
            !["screen", "accessibility", "inputMonitoring"].includes(
              b.permission,
            )
          )
            throw new Error("未知系统权限");
          return json(await desktop.permissions(b.permission));
        }
        if (path === "/desktop/pause" && method === "POST") {
          desktop.pause();
          return json(desktop.state);
        }
        if (path === "/resources" && method === "POST")
          return json(await resources.mutate(await body(request)));
        if (path === "/rules" && method === "GET")
          return json(resources.rules(url.searchParams.get("projectId")));
        if (path === "/rules" && method === "PUT")
          return json(await resources.saveRules(await body(request)));
        if (path === "/bindings" && method === "POST") {
          const b = await body(request),
            session = store.session(str(b.sessionId, "会话 ID"));
          if (!session || session.archived)
            throw new Error("会话不存在或已归档");
          if (
            !store.db
              .query("SELECT key FROM bindings WHERE key=?")
              .get(str(b.key, "入口"))
          )
            throw new Error("入口绑定不存在");
          store.db
            .query("UPDATE bindings SET sessionId=? WHERE key=?")
            .run(session.id, b.key);
          changed();
          return json({ saved: true });
        }
        if (path === "/feishu" && method === "POST") {
          const b = await body(request);
          const previous = store.getConfig<FeishuConfig | null>("feishu", null);
          const appId = str(b.appId, "App ID");
          const config: FeishuConfig = {
            appId,
            appSecret:
              b.appSecret ||
              (previous?.appId === appId ? previous.appSecret : ""),
            botId: b.botId || undefined,
            enabled: b.enabled !== false,
          };
          if (!config.appSecret) throw new Error("请填写 App Secret");
          store.setConfig("feishu", config);
          void feishu.start();
          changed();
          return json({ saved: true });
        }
        if (path === "/subscriptions" && method === "POST") {
          const b = await body(request);
          const kind = allowed(
            b.kind,
            ["sse", "peer", "file", "process"],
            "来源类型",
          ) as Subscription["kind"];
          const previous = b.id
            ? store.subscriptions().find((s) => s.id === b.id)
            : undefined;
          if (b.id && !previous) throw new Error("连接不存在，请重新添加");
          const target = store.session(b.targetSessionId);
          if (
            (!target || target.archived) &&
            !(
              previous &&
              !b.enabled &&
              previous.targetSessionId === b.targetSessionId
            )
          )
            throw new Error("请选择目标会话");
          const s: Subscription = {
            id: b.id || randomUUID(),
            name: str(b.name, "订阅名称"),
            kind,
            targetSessionId: b.targetSessionId,
            enabled: !!b.enabled,
          };
          if (kind === "sse" || kind === "peer") {
            const url = new URL(str(b.url, "地址"));
            if (!["http:", "https:"].includes(url.protocol))
              throw new Error("SSE 需要 HTTP(S)");
            s.url = url.href;
          }
          if (kind === "file") s.path = resolve(str(b.path, "文件路径"));
          if (kind === "process") {
            if (
              !Array.isArray(b.command) ||
              !b.command.length ||
              b.command.some((x: any) => typeof x !== "string")
            )
              throw new Error("命令必须是参数数组");
            s.command = b.command;
          }
          if (kind === "peer") {
            s.me = str(b.me, "Peer 身份");
            if (
              !Array.isArray(b.trustedSenders) ||
              b.trustedSenders.some((x: any) => typeof x !== "string")
            )
              throw new Error("填写受信任 Peer 名单");
            s.trustedSenders = b.trustedSenders;
          }
          if (b.token)
            store.setConfig(`monitorSecret:${s.id}`, str(b.token, "Token"));
          if (b.token && b.id) {
            const prior = store.subscriptions().find((x) => x.id === s.id);
            if (prior) {
              store.saveSubscription({ ...prior, enabled: false });
              monitor.reload();
            }
          }
          store.saveSubscription(s);
          monitor.reload();
          return json(s);
        }
        if (path === "/attachments" && method === "POST") {
          const form = await request.formData(),
            file = form.get("file");
          if (!(file instanceof File)) throw new Error("缺少文件");
          const name = basename(file.name).replace(/[\\/]/g, "_");
          const path = join(root, "attachments", `${randomUUID()}-${name}`);
          await Bun.write(path, file);
          return json({
            path,
            name,
            mimeType: file.type || "application/octet-stream",
          });
        }
        if (path === "/experiments") {
          const dir = join(root, "experiments");
          const records = existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith(".jsonl"))
                .flatMap((f) =>
                  readFileSync(join(dir, f), "utf8")
                    .trim()
                    .split("\n")
                    .slice(-20)
                    .map((l) => {
                      try {
                        return JSON.parse(l);
                      } catch {
                        return null;
                      }
                    }),
                )
                .filter(Boolean)
                .sort((a, b) => a.at - b.at)
                .slice(-30)
            : [];
          return json(records);
        }
        if (path === "/outbox" && method === "GET")
          return json(store.replies());
        if (path === "/outbox/retry" && method === "POST") {
          const b = await body(request);
          const row = store.db
            .query("SELECT status FROM outbox WHERE id=?")
            .get(str(b.id, "回复 ID")) as any;
          if (!row) throw new Error("回复不存在");
          if (row.status === "uncertain" && !b.verifiedMissing)
            throw new Error("发送结果不明，需要先核对收件端未收到");
          if (!["failed", "uncertain"].includes(row.status))
            throw new Error("此回复不需要重发");
          store.replyStatus(b.id, "pending");
          void feishu.flush();
          void monitor.flush();
          return json({ queued: true });
        }
        if (path === "/diagnostics")
          return json({
            platform: process.platform,
            arch: process.arch,
            bun: Bun.version,
            dataRoot: root,
            monitorErrors: Object.fromEntries(monitor.errors),
            outbox: store.db.query("SELECT id,status,error FROM outbox").all(),
          });
        return json({ error: "接口不存在" }, 404);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    },
  });
  if (store.getSettings().computer)
    void desktop.enable().catch((e) => {
      desktop.state.reason = String(e);
      changed();
    });
  void feishu.start();
  monitor.reload();
  runtimes.wakeAll();
  return {
    server,
    store,
    runtimes,
    feishu,
    monitor,
    state,
    async close() {
      if (closing) return;
      closing = true;
      await oauth.close();
      await monitor.stop();
      await feishu.stop();
      await runtimes.shutdown();
      await desktop.close();
      await server.stop(true);
      store.close();
    },
  };
}
