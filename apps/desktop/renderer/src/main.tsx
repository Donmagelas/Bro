import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  Annotation,
  Attachment,
  ChatMessage,
  HostState,
  Input,
  ModelChoice,
  Project,
  Session,
  Thinking,
} from "../../../../packages/contracts";
import "./style.css";
import { ResourcePanel } from "./ResourcePanel";
import { ExperimentPanel } from "./ExperimentPanel";
import { useDrafts } from "./useDrafts";
import { OutboxPanel } from "./OutboxPanel";
import { PixelIcon, PixelScene, rooms } from "./PixelScene";

declare global {
  interface Window {
    bro: {
      request: (path: string, method?: string, body?: unknown) => Promise<any>;
      stopHost: () => Promise<void>;
      loginItem: (enabled?: boolean) => Promise<boolean>;
      directory: () => Promise<string | null>;
      attachments: () => Promise<Attachment[]>;
      open: (path: string) => Promise<void>;
      onEvent: (fn: (event: any) => void) => () => void;
    };
  }
}
const brandIcon = new URL("../../assets/icon.png", import.meta.url).href;
const thinkingLabels: Record<Thinking, string> = {
  off: "不思考",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
};
const api = (path: string, method = "GET", body?: unknown) =>
  window.bro.request(path, method, body);
const labels: Record<string, string> = {
  idle: "就绪",
  starting: "启动中",
  waiting: "等待工作目录",
  running: "进行中",
  interrupted: "已中断",
  error: "需要处理",
  queued: "排队中",
  failed: "失败",
  completed: "完成",
  cancelled: "已停止",
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    folder: <path d="M3 7V5h6l2 2h10v13H3z" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z" />
      </>
    ),
    send: <path d="M12 20V4m-6 6 6-6 6 6" />,
    clip: <path d="m8 14 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L13 3" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    message: <path d="M4 4h16v12H9l-5 4z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    pin: <path d="m8 3 8 0-1 6 4 5H5l4-5zm4 11v7" />,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.message}
    </svg>
  );
}
function errorText(error: unknown): string {
  return String(error)
    .replace(/^Error: /, "")
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(?:Error: )+/, "");
}
function textOf(message: ChatMessage): string {
  if (
    message.role === "user" &&
    message.bro?.inputs.every((i) => i.text !== undefined)
  )
    return message.bro.inputs.map((i) => i.text).join("\n\n");
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}
function App() {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [state, setState] = useState<HostState | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [inputs, setInputs] = useState<Input[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const draftKey =
    selected || (activeProjectId ? `project:${activeProjectId}:new` : null);
  const {
    draft,
    setDraft,
    attachments,
    setAttachments,
    annotations,
    setAnnotations,
    clearSubmitted,
    restoreDraft,
  } = useDrafts(draftKey);
  const [search, setSearch] = useState(""),
    [settings, setSettings] = useState(false),
    [settingsTab, setSettingsTab] = useState("模型"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<"queue" | "steer">("queue");
  const [live, setLive] = useState(""),
    [tool, setTool] = useState(""),
    [menu, setMenu] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    detail: string;
    action: () => Promise<void>;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [outgoing, setOutgoing] = useState<{
    id: string;
    sessionId: string | null;
    text: string;
  } | null>(null);
  const sendLock = useRef(false);
  const followBottom = useRef(true);
  const statsSequence = useRef(0);
  const [diff, setDiff] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [question, setQuestion] = useState<{
    title: string;
    value: string;
    submit: (value: string) => void;
  } | null>(null);
  const loadSequence = useRef(0),
    stateSequence = useRef(0);
  const selectedRef = useRef(selected),
    bottom = useRef<HTMLDivElement>(null);
  selectedRef.current = selected;
  const connectionsKey = JSON.stringify(state?.connections || []);
  useEffect(() => {
    let active = true;
    void api("/models")
      .then((models) => {
        if (active) setModels(models);
      })
      .catch((error) => {
        if (active) setError(`模型列表加载失败：${errorText(error)}`);
      });
    return () => {
      active = false;
    };
  }, [connectionsKey]);
  const refresh = useCallback(async () => {
    try {
      const seq = ++stateSequence.current;
      const result = await api("/state");
      if (seq === stateSequence.current) {
        setState(result);
        setError((current) => (current === "后台连接正在恢复…" ? "" : current));
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);
  const load = useCallback(async (id: string) => {
    try {
      const seq = ++loadSequence.current;
      const data = await api(`/sessions/${id}/history`);
      if (selectedRef.current === id && seq === loadSequence.current) {
        setLoadingHistory(false);
        setMessages(data.messages);
        setInputs(data.inputs);
      }
    } catch (e) {
      if (selectedRef.current === id) {
        setLoadingHistory(false);
        setError(String(e));
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    return window.bro.onEvent((event) => {
      if (event.type === "state") {
        void refresh();
        if (selectedRef.current) void load(selectedRef.current);
      }
      if (event.sessionId === selectedRef.current) {
        if (event.type === "runtime") {
          const e = event.data;
          if (
            e.type === "message_update" &&
            e.assistantMessageEvent?.type === "text_delta"
          )
            setLive((v) => v + e.assistantMessageEvent.delta);
          if (e.type === "tool_execution_start") setTool(e.toolName);
          if (e.type === "tool_execution_end") setTool("");
          if (
            e.type === "message_end" ||
            (e.type === "agent_end" && e.isTerminal !== false)
          ) {
            setLive("");
            if (selectedRef.current) void load(selectedRef.current);
          }
        } else if (event.type === "history") {
          loadSequence.current++;
          setMessages(event.data);
          setLoadingHistory(false);
          setLive("");
          setTool("");
        }
      }
      if (event.type === "disconnected") setError("后台连接正在恢复…");
    });
  }, [refresh, load]);
  useEffect(() => {
    setUsage(null);
    setMessages([]);
    setInputs([]);
    setLive("");
    setTool("");
    setMenu(false);
    setLoadingHistory(!!selected);
    followBottom.current = true;
    if (selected) void load(selected);
  }, [selected, load]);
  useEffect(() => {
    if (followBottom.current)
      bottom.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length, inputs.length, outgoing, live, tool]);
  const session = [
    ...(state?.sessions || []),
    ...(state?.archivedSessions || []),
  ].find((s) => s.id === selected);
  const project = state?.projects.find(
    (p) => p.id === (session ? session.projectId : activeProjectId),
  );
  useEffect(() => {
    const seq = ++statsSequence.current;
    if (!selected) return;
    void api(`/sessions/${selected}/stats`)
      .then((value) => {
        if (seq === statsSequence.current && selectedRef.current === selected)
          setUsage(value);
      })
      .catch(() => {});
  }, [selected, session?.status]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const newSession = async (
    projectId = state?.projects.find(
      (p) => p.id === activeProjectId && !p.archived,
    )?.id,
  ) => {
    const s = await api("/sessions", "POST", { projectId });
    selectedRef.current = s.id;
    setSelected(s.id);
    setActiveProjectId(projectId || null);
    setState(
      (current) =>
        current && {
          ...current,
          sessions: [s, ...current.sessions.filter((item) => item.id !== s.id)],
        },
    );
    setShowArchived(false);
    setSearch("");
    void refresh();
    return s.id as string;
  };
  async function send() {
    if (!draft.trim() || sendLock.current || savingModel || session?.archived)
      return;
    if (!(session?.connectionId || state?.settings.defaultConnectionId)) {
      setSettingsTab("模型");
      setSettings(true);
      setError("请先连接并选择一个模型。");
      return;
    }
    sendLock.current = true;
    setBusy(true);
    setError("");
    followBottom.current = true;
    const snapshot = { text: draft, attachments, annotations };
    const inputId = crypto.randomUUID();
    let id = selected;
    setOutgoing({ id: inputId, sessionId: id, text: snapshot.text });
    try {
      if (!id) id = await newSession();
      setOutgoing({ id: inputId, sessionId: id, text: snapshot.text });
      const input = await api(`/sessions/${id}/messages`, "POST", {
        id: inputId,
        ...snapshot,
        mode,
      });
      if (selectedRef.current === id && input.id)
        setInputs((old) => [...old.filter((i) => i.id !== input.id), input]);
      clearSubmitted(snapshot);
      setOutgoing(null);
      void load(id);
      void refresh();
    } catch (e) {
      setOutgoing(null);
      restoreDraft(id || draftKey, snapshot);
      setError(errorText(e));
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void run(() => newSession());
      }
      if (event.key === "Escape") {
        setQuestion(null);
        setDiff(null);
        setSettings(false);
        setMenu(false);
        if (!confirming) setConfirmation(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const activeConnection = state?.connections.find(
    (c) =>
      c.id === (session?.connectionId || state?.settings.defaultConnectionId),
  );
  const activeModelId = session
    ? session.model || activeConnection?.model
    : state?.settings.defaultModel || activeConnection?.model;
  const activeModel = models.find(
    (m) => m.connectionId === activeConnection?.id && m.id === activeModelId,
  );
  const selectedThinking = (session?.thinking ||
    state?.settings.defaultThinking ||
    "medium") as Thinking;
  const changeModel = async (selection: {
    connectionId?: string;
    model?: string;
    thinking?: Thinking;
  }) => {
    setSavingModel(true);
    const sessionId = selected;
    try {
      await run(() =>
        sessionId
          ? api(`/sessions/${sessionId}`, "PATCH", selection)
          : api("/settings", "PATCH", {
              defaultConnectionId: selection.connectionId,
              defaultModel: selection.model,
              defaultThinking: selection.thinking,
            }),
      );
    } finally {
      setSavingModel(false);
    }
  };
  function sessionAction(target: Session, action: string) {
    setMenu(false);
    setError("");
    if (action === "rename") {
      setQuestion({
        title: "会话名称",
        value: target.title,
        submit: (title) =>
          void run(() => api(`/sessions/${target.id}`, "PATCH", { title })),
      });
    } else if (action === "pin") {
      void run(() =>
        api(`/sessions/${target.id}`, "PATCH", { pinned: !target.pinned }),
      );
    } else if (action === "archive") {
      void run(async () => {
        await api(`/sessions/${target.id}`, "PATCH", {
          archived: !target.archived,
        });
        if (selectedRef.current === target.id && !target.archived) {
          selectedRef.current = null;
          setSelected(null);
        }
      });
    } else if (action === "delete") {
      setConfirmation({
        title: `删除会话“${target.title}”？`,
        detail: "会话将从 Bro 中删除，无法恢复。本机项目文件不会删除。",
        action: async () => {
          await api(`/sessions/${target.id}`, "DELETE");
          if (selectedRef.current === target.id) {
            selectedRef.current = null;
            setSelected(null);
          }
        },
      });
    }
  }
  function projectAction(target: Project, action: string) {
    setError("");
    if (action === "rename") {
      setQuestion({
        title: "项目名称",
        value: target.name,
        submit: (name) =>
          void run(() => api(`/projects/${target.id}`, "PATCH", { name })),
      });
    } else if (action === "archive") {
      void run(() =>
        api(`/projects/${target.id}`, "PATCH", { archived: !target.archived }),
      );
    } else if (action === "delete") {
      setConfirmation({
        title: `移除项目“${target.name}”？`,
        detail:
          "只移除 Bro 中的项目分组和项目专属资源配置，会话保留到其他会话，本机目录与文件保留。",
        action: async () => {
          await api(`/projects/${target.id}`, "DELETE");
          setActiveProjectId((current) =>
            current === target.id ? null : current,
          );
        },
      });
    }
  }
  function annotate(message: ChatMessage) {
    const selection = window.getSelection();
    const quote = selection?.toString().trim();
    const node =
      selection?.anchorNode?.parentElement?.closest("[data-message-id]");
    if (!quote || node?.getAttribute("data-message-id") !== message.id) {
      setError("先选中回复中的一段文字，再添加批注。");
      return;
    }
    setQuestion({
      title: "对选中内容的意见",
      value: "",
      submit: (comment) =>
        setAnnotations((v) => [
          ...v,
          { messageId: message.id, quote, comment },
        ]),
    });
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src={brandIcon} alt="" />
          </span>
          <strong>Bro</strong>
        </div>
        <button
          className="nav-button"
          onClick={() => void run(() => newSession())}
        >
          <Icon name="plus" />
          新会话<span className="keyhint">⌘ / Ctrl N</span>
        </button>
        <label className="search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <SidebarTree
          projects={state?.projects || []}
          sessions={[
            ...(state?.sessions || []),
            ...(state?.archivedSessions || []),
          ]}
          selected={selected}
          search={search}
          archived={showArchived}
          onArchiveView={() => {
            setShowArchived(!showArchived);
            setSearch("");
          }}
          onSelect={(s) => {
            selectedRef.current = s.id;
            setSelected(s.id);
            setActiveProjectId(s.projectId);
          }}
          onNew={(id) => void run(() => newSession(id))}
          onAdd={() =>
            void run(async () => {
              const path = await window.bro.directory();
              if (path) await api("/projects", "POST", { path });
            })
          }
          onSessionAction={sessionAction}
          onProjectAction={projectAction}
        />
        <div className="sidebar-bottom">
          <div className="host-status">
            <span className={`status-dot ${state ? "idle" : "error"}`} />
            {state ? "后台已连接" : "连接后台…"}
            <span>0.1</span>
          </div>
          <button className="nav-button" onClick={() => setSettings(true)}>
            <Icon name="settings" />
            设置与连接
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">{project?.name || "工作台"}</span>
            <Icon name="chevron" size={13} />
            <strong>{session?.title || "新会话"}</strong>
          </div>
          <div className="top-actions">
            {session && (
              <>
                <span className={`status-chip ${session.status}`}>
                  {session.archived ? "已归档" : labels[session.status]}
                </span>
                <button
                  className="icon-button"
                  aria-label="会话操作"
                  onClick={() => setMenu(!menu)}
                >
                  <Icon name="more" />
                </button>
              </>
            )}
            {menu && session && (
              <div className="popover">
                <button
                  onClick={() =>
                    void run(() =>
                      api(`/sessions/${selected}/compact`, "POST", {}),
                    )
                  }
                >
                  压缩上下文
                </button>
                <button
                  onClick={() =>
                    void run(async () => {
                      setDiff(await api(`/sessions/${selected}/diff`));
                      setMenu(false);
                    })
                  }
                >
                  查看改动
                </button>
                <button onClick={() => sessionAction(session, "rename")}>
                  重命名
                </button>
                <button onClick={() => sessionAction(session, "pin")}>
                  {session.pinned ? "取消置顶" : "置顶"}
                </button>
                <button
                  onClick={() =>
                    void run(async () => {
                      const s = await api(
                        `/sessions/${selected}/fork`,
                        "POST",
                        {},
                      );
                      setSelected(s.id);
                      setShowArchived(false);
                    })
                  }
                >
                  创建分支
                </button>
                <button onClick={() => sessionAction(session, "archive")}>
                  {session.archived ? "恢复会话" : "归档会话"}
                </button>
                <button
                  className="danger"
                  onClick={() => sessionAction(session, "delete")}
                >
                  删除会话
                </button>
              </div>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <Icon name="close" size={15} />
            </button>
          </div>
        )}
        <div
          className="conversation"
          onScroll={(e) => {
            const el = e.currentTarget;
            followBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
        >
          {!messages.length &&
            !inputs.length &&
            !live &&
            !outgoing &&
            !loadingHistory && (
              <section className="welcome">
                <div className="welcome-art">
                  <PixelScene />
                </div>
                <div className="welcome-copy">
                  <h1>
                    大哥，今天砍谁？<span className="pixel-cursor">_</span>
                  </h1>
                </div>
                <div className="suggestions">
                  {[
                    "看看这个项目，从哪里开始？",
                    "帮我定位并修复一个问题",
                    "查看其他会话的进展",
                  ].map((t) => (
                    <button key={t} onClick={() => setDraft(t)}>
                      {t}
                      <Icon name="chevron" size={14} />
                    </button>
                  ))}
                </div>
                {!state?.connections.length && (
                  <button
                    className="connect-callout"
                    onClick={() => {
                      setSettingsTab("模型");
                      setSettings(true);
                    }}
                  >
                    连接你的模型，开始使用 <Icon name="chevron" size={14} />
                  </button>
                )}
              </section>
            )}
          <div className="messages" aria-live="polite">
            {loadingHistory && !outgoing && !inputs.length && (
              <div className="loading-history">
                <span className="spinner" />
                正在读取会话…
              </div>
            )}
            {messages
              .filter(
                (m) =>
                  m.role !== "assistant" ||
                  textOf(m) ||
                  (Array.isArray(m.content) &&
                    m.content.some((c: any) => c.type === "image")),
              )
              .map((m) => (
                <article
                  data-message-id={m.id}
                  key={m.id}
                  className={`message ${m.role}`}
                >
                  {m.role === "toolResult" ? (
                    <details className="tool-result">
                      <summary>
                        <Icon name="activity" size={14} />
                        {m.toolName || "工具结果"}
                      </summary>
                      <pre>{textOf(m)}</pre>
                      {Array.isArray(m.content) &&
                        m.content
                          .filter((c: any) => c.type === "image" && c.data)
                          .map((c: any, i: number) => (
                            <img
                              className="chat-image"
                              key={i}
                              alt="工具截图"
                              src={`data:${c.mimeType};base64,${c.data}`}
                            />
                          ))}
                    </details>
                  ) : (
                    <>
                      <div className="message-author">
                        {m.role === "user" ? "你" : "Bro"}
                      </div>
                      {Array.isArray(m.content) &&
                        m.content
                          .filter((c: any) => c.type === "image" && c.data)
                          .map((c: any, i: number) => (
                            <img
                              className="chat-image"
                              key={i}
                              src={`data:${c.mimeType};base64,${c.data}`}
                              alt="会话图片"
                            />
                          ))}
                      <div className="markdown">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  if (href)
                                    void run(() => window.bro.open(href));
                                }}
                              >
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {textOf(m)}
                        </Markdown>
                      </div>
                      {!!m.bro?.inputs.some((i) => i.attachments?.length) && (
                        <div className="message-attachments">
                          {m.bro.inputs
                            .flatMap((i) => i.attachments || [])
                            .map((a, i) => (
                              <button
                                key={`${a.path}-${i}`}
                                onClick={() =>
                                  void run(() => window.bro.open(a.path))
                                }
                              >
                                <Icon name="clip" size={14} />
                                {a.name}
                              </button>
                            ))}
                        </div>
                      )}
                      {m.bro?.inputs
                        .flatMap((i) => i.annotations || [])
                        .map((a, i) => (
                          <div className="message-annotation" key={i}>
                            <blockquote>{a.quote}</blockquote>
                            <p>{a.comment}</p>
                          </div>
                        ))}
                      {m.role === "assistant" && (
                        <button
                          className="annotation-button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => annotate(m)}
                        >
                          选中文字后批注
                        </button>
                      )}
                    </>
                  )}
                </article>
              ))}
            {live && (
              <article className="message assistant">
                <div className="message-author">Bro</div>
                <div className="markdown">
                  <Markdown>{live}</Markdown>
                </div>
              </article>
            )}
            {tool && (
              <div className="running-tool">
                <span className="spinner" />
                {tool}
              </div>
            )}
            {outgoing?.sessionId === selected && (
              <article className="message user sending">
                <div className="message-author">你 · 发送中</div>
                <div className="plain-message">{outgoing.text}</div>
              </article>
            )}
            {inputs
              .filter(
                (i) =>
                  i.status !== "cancelled" &&
                  !messages.some((m) =>
                    m.bro?.inputs.some((item) => item.id === i.id),
                  ) &&
                  i.id !== outgoing?.id,
              )
              .map((i) => (
                <div className={`queue-item ${i.status}`} key={i.id}>
                  <span>{labels[i.status]}</span>
                  <p>{i.text}</p>
                  {i.error && <small>{i.error}</small>}
                </div>
              ))}
            {!live &&
              !tool &&
              ["starting", "waiting", "running"].includes(
                session?.status || "",
              ) && (
                <div className="running-tool">
                  <span className="spinner" />
                  {session?.status === "starting"
                    ? "正在唤醒 Bro…"
                    : session?.status === "waiting"
                      ? "等待工作目录可用…"
                      : "Bro 正在处理…"}
                </div>
              )}
            {session?.error && (
              <div className="inline-error">
                {session.error}
                <button
                  onClick={() =>
                    void run(() =>
                      api(`/sessions/${selected}/resume`, "POST", {}),
                    )
                  }
                >
                  继续处理队列
                </button>
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>
        <div className="composer-wrap">
          <div className="composer">
            {!!attachments.length && (
              <div className="attachments">
                {attachments.map((a, i) => (
                  <button
                    key={a.path}
                    onClick={() =>
                      setAttachments((v) => v.filter((_, n) => n !== i))
                    }
                  >
                    {a.name} ×
                  </button>
                ))}
              </div>
            )}
            {!!annotations.length && (
              <div className="annotations">
                {annotations.map((a, i) => (
                  <div key={i}>
                    <blockquote>{a.quote}</blockquote>
                    <span>{a.comment}</span>
                    <button
                      onClick={() =>
                        setAnnotations((v) => v.filter((_, n) => n !== i))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              aria-label="消息"
              placeholder="交给 Bro 一件事…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <div>
                <button
                  className="icon-button"
                  aria-label="添加附件"
                  onClick={() =>
                    void run(async () => {
                      const files = await window.bro.attachments();
                      setAttachments((v) => [...v, ...files]);
                    })
                  }
                >
                  <Icon name="clip" />
                </button>
                <select
                  aria-label="模型"
                  disabled={savingModel || !models.length}
                  value={
                    activeConnection && activeModelId
                      ? JSON.stringify([activeConnection.id, activeModelId])
                      : ""
                  }
                  onChange={(e) => {
                    const [connectionId, model] = JSON.parse(e.target.value);
                    void changeModel({ connectionId, model });
                  }}
                >
                  <option value="" disabled>
                    选择模型
                  </option>
                  {!activeModel && activeConnection && activeModelId && (
                    <option
                      value={JSON.stringify([
                        activeConnection.id,
                        activeModelId,
                      ])}
                    >
                      {activeModelId}
                    </option>
                  )}
                  {state?.connections.map((connection) => (
                    <optgroup key={connection.id} label={connection.name}>
                      {models
                        .filter((model) => model.connectionId === connection.id)
                        .map((model) => (
                          <option
                            key={model.id}
                            value={JSON.stringify([connection.id, model.id])}
                          >
                            {model.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                {!!activeModel?.thinkingLevels.length && (
                  <select
                    aria-label="思考强度"
                    disabled={savingModel}
                    value={
                      activeModel.thinkingLevels.includes(selectedThinking)
                        ? selectedThinking
                        : activeModel.defaultThinking
                    }
                    onChange={(e) =>
                      void changeModel({ thinking: e.target.value as Thinking })
                    }
                  >
                    {activeModel.thinkingLevels.map((v) => (
                      <option key={v} value={v}>
                        思考：{thinkingLabels[v]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <select
                  aria-label="投递方式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="queue">排队发送</option>
                  <option value="steer">补充说明</option>
                </select>
                {["starting", "running", "waiting"].includes(
                  session?.status || "",
                ) && (
                  <button
                    className="stop-button"
                    aria-label="停止运行"
                    onClick={() =>
                      void run(() =>
                        api(`/sessions/${selected}/stop`, "POST", {}),
                      )
                    }
                  >
                    <Icon name="stop" size={15} />
                  </button>
                )}
                <button
                  className="send-button"
                  aria-label="发送"
                  disabled={
                    !draft.trim() || busy || savingModel || session?.archived
                  }
                  onClick={() => void send()}
                >
                  <Icon name="send" size={18} />
                </button>
              </div>
            </div>
            {selected && state?.pendingRefresh.includes(selected) && (
              <div className="description" role="status">
                新配置将在下一轮生效。
              </div>
            )}
          </div>
          <div className="composer-footer">
            <span>
              {session?.cwd ||
                project?.path ||
                state?.settings.defaultCwd ||
                "本机工作目录"}
            </span>
            <span>
              {usage?.context && (
                <span title="OMP 本地估算">
                  上下文约 {Number(usage.context.tokens).toLocaleString()} /{" "}
                  {Number(usage.context.contextWindow).toLocaleString()} ·{" "}
                </span>
              )}
              {messages.some((m: any) => m.usage)
                ? `${(usage?.totals?.tokens?.total || messages.reduce((sum, m: any) => sum + (m.usage?.totalTokens || 0), 0)).toLocaleString()} tokens · ${state?.connections.find((c) => c.id === session?.connectionId)?.kind === "api" ? "费用未配置" : "账号额度以服务端为准"}`
                : "Enter 发送 · Shift Enter 换行"}
            </span>
          </div>
        </div>
      </main>
      {settings && state && (
        <SettingsPanel
          state={state}
          tab={settingsTab}
          setTab={setSettingsTab}
          close={() => setSettings(false)}
          run={run}
          selected={selected}
        />
      )}
      {diff && (
        <div className="modal-backdrop">
          <section className="diff-modal">
            <button
              className="modal-close icon-button"
              onClick={() => setDiff(null)}
            >
              关闭
            </button>
            <h3>工作目录改动</h3>
            <pre>{diff.status || "工作目录干净"}</pre>
            {diff.unstaged && (
              <>
                <h4>未暂存</h4>
                <pre>{diff.unstaged}</pre>
              </>
            )}
            {diff.staged && (
              <>
                <h4>已暂存</h4>
                <pre>{diff.staged}</pre>
              </>
            )}
          </section>
        </div>
      )}
      {confirmation && (
        <div className="modal-backdrop">
          <section
            className="question-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirmation-title"
          >
            <h3 id="confirmation-title">{confirmation.title}</h3>
            <p>{confirmation.detail}</p>
            {error && (
              <p className="danger" role="alert">
                {error}
              </p>
            )}
            <div>
              <button
                autoFocus
                className="secondary"
                disabled={confirming}
                onClick={() => setConfirmation(null)}
              >
                取消
              </button>
              <button
                className="primary danger"
                disabled={confirming}
                onClick={() => {
                  if (confirming) return;
                  setConfirming(true);
                  void run(async () => {
                    await confirmation.action();
                    setConfirmation(null);
                  }).finally(() => setConfirming(false));
                }}
              >
                {confirming ? "处理中…" : "确认"}
              </button>
            </div>
          </section>
        </div>
      )}
      {question && (
        <div className="modal-backdrop">
          <form
            className="question-modal"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.value.trim()) {
                question.submit(question.value);
                setQuestion(null);
              }
            }}
          >
            <h3>{question.title}</h3>
            <textarea
              autoFocus
              value={question.value}
              onChange={(e) =>
                setQuestion((q) => (q ? { ...q, value: e.target.value } : null))
              }
            />
            <div>
              <button
                type="button"
                className="secondary"
                onClick={() => setQuestion(null)}
              >
                取消
              </button>
              <button className="primary" disabled={!question.value.trim()}>
                确定
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SidebarTree({
  projects,
  sessions,
  selected,
  search,
  archived,
  onArchiveView,
  onSelect,
  onNew,
  onAdd,
  onSessionAction,
  onProjectAction,
}: {
  projects: Project[];
  sessions: Session[];
  selected: string | null;
  search: string;
  archived: boolean;
  onArchiveView: () => void;
  onSelect: (session: Session) => void;
  onNew: (projectId?: string) => void;
  onAdd: () => void;
  onSessionAction: (session: Session, action: string) => void;
  onProjectAction: (project: Project, action: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("bro.sidebar.collapsed.v1") || "[]",
      );
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  });
  const [context, setContext] = useState<{
    kind: "session" | "project";
    id: string;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const next = old.includes(id)
        ? old.filter((value) => value !== id)
        : [...old, id];
      try {
        localStorage.setItem("bro.sidebar.collapsed.v1", JSON.stringify(next));
      } catch {}
      return next;
    });
  useEffect(() => {
    const p = sessions.find((s) => s.id === selected)?.projectId;
    if (p) setCollapsed((old) => old.filter((id) => id !== p));
  }, [selected]);
  useEffect(() => {
    if (!context) return;
    contextRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => {
      if (!contextRef.current?.contains(event.target as Node)) setContext(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContext(null);
        context.trigger.focus();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [context]);
  useEffect(() => setContext(null), [archived, search]);
  const openMenu = (
    event: React.MouseEvent<HTMLElement>,
    kind: "project" | "session",
    id: string,
  ) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.type === "contextmenu" ? event.clientX : rect.right;
    const y = event.type === "contextmenu" ? event.clientY : rect.top;
    setContext({
      kind,
      id,
      x: Math.min(x, window.innerWidth - 210),
      y: Math.min(y, window.innerHeight - 210),
      trigger: event.currentTarget,
    });
  };
  const byId = new Map(projects.map((p) => [p.id, p]));
  const query = search.trim().toLocaleLowerCase();
  const matches = (s: Session) =>
    s.title.toLocaleLowerCase().includes(query) ||
    !!byId
      .get(s.projectId || "")
      ?.name.toLocaleLowerCase()
      .includes(query);
  const visible = sessions.filter(
    (s) =>
      (archived
        ? s.archived || !!byId.get(s.projectId || "")?.archived
        : !s.archived && !byId.get(s.projectId || "")?.archived) && matches(s),
  );
  const pinned = archived ? [] : visible.filter((s) => s.pinned);
  const rows = visible.filter((s) => archived || !s.pinned);
  const ungrouped = rows.filter((s) => !s.projectId || !byId.has(s.projectId));
  const visibleProjects = projects.filter(
    (p) =>
      (archived
        ? p.archived || rows.some((s) => s.projectId === p.id)
        : !p.archived) &&
      (!query ||
        p.name.toLocaleLowerCase().includes(query) ||
        rows.some((s) => s.projectId === p.id)),
  );
  function sessionRow(s: Session) {
    return (
      <div
        className={`session-row ${s.id === selected ? "selected" : ""}`}
        key={s.id}
        onContextMenu={(e) => openMenu(e, "session", s.id)}
      >
        <button
          className="session-item"
          data-session-id={s.id}
          title={s.title}
          aria-current={s.id === selected ? "page" : undefined}
          onClick={() => onSelect(s)}
        >
          <span className={`status-dot ${s.status}`} />
          <span className="session-name">{s.title}</span>
          {!!s.queued && <span className="count">{s.queued}</span>}
        </button>
        <button
          className="row-menu"
          aria-label={`会话 ${s.title} 的操作`}
          title="会话操作"
          aria-haspopup="menu"
          aria-expanded={context?.kind === "session" && context.id === s.id}
          onClick={(e) => openMenu(e, "session", s.id)}
        >
          <Icon name="more" size={16} />
        </button>
      </div>
    );
  }
  const menuSession =
    context?.kind === "session"
      ? sessions.find((s) => s.id === context.id)
      : undefined;
  const menuProject =
    context?.kind === "project" ? byId.get(context.id) : undefined;
  function action(name: string) {
    setContext(null);
    if (menuSession) onSessionAction(menuSession, name);
    if (menuProject) onProjectAction(menuProject, name);
  }
  return (
    <>
      <div className="sidebar-tree" onScroll={() => setContext(null)}>
        {archived && <div className="section-label">已归档</div>}
        {!!pinned.length && (
          <section aria-label="置顶会话">
            <div className="section-label">置顶</div>
            {pinned.map(sessionRow)}
          </section>
        )}
        <div className="section-label">
          项目
          {!archived && (
            <button aria-label="添加项目" onClick={onAdd}>
              <Icon name="plus" size={15} />
            </button>
          )}
        </div>
        {visibleProjects.map((p) => {
          const children = rows.filter((s) => s.projectId === p.id);
          const expanded = !!query || !collapsed.includes(p.id);
          return (
            <section
              className="project-group"
              key={p.id}
              aria-label={`项目 ${p.name}`}
            >
              <div
                className="project"
                onContextMenu={(e) => openMenu(e, "project", p.id)}
              >
                <button
                  className="project-open"
                  aria-expanded={expanded}
                  title={p.path}
                  onClick={() => toggle(p.id)}
                >
                  <span
                    className={`project-chevron ${expanded ? "expanded" : ""}`}
                  >
                    <Icon name="chevron" size={13} />
                  </span>
                  <Icon name="folder" size={15} />
                  <span className="project-name">{p.name}</span>
                </button>
                {!archived && (
                  <button
                    className="project-add"
                    aria-label={`在 ${p.name} 中新建会话`}
                    title="新建会话"
                    onClick={() => onNew(p.id)}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                )}
                <button
                  className="row-menu"
                  aria-label={`项目 ${p.name} 的操作`}
                  title="项目操作"
                  aria-haspopup="menu"
                  aria-expanded={
                    context?.kind === "project" && context.id === p.id
                  }
                  onClick={(e) => openMenu(e, "project", p.id)}
                >
                  <Icon name="more" size={16} />
                </button>
              </div>
              {expanded && (
                <div className="project-sessions">
                  {children.map(sessionRow)}
                  {!children.length && (
                    <div className="sidebar-hint">
                      {pinned.some((s) => s.projectId === p.id)
                        ? "会话已置顶"
                        : "暂无会话"}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {!!ungrouped.length && (
          <section aria-label="其他会话">
            <div className="section-label">其他会话</div>
            {ungrouped.map(sessionRow)}
          </section>
        )}
        {!visible.length && !visibleProjects.length && (
          <div className="sidebar-hint">
            {query
              ? "没有匹配的项目或会话"
              : archived
                ? "暂无归档"
                : "暂无会话"}
          </div>
        )}
      </div>
      <button className="archive-nav" onClick={onArchiveView}>
        {archived ? "返回会话" : "已归档"}
      </button>
      {context && (menuSession || menuProject) && (
        <div
          className="popover tree-menu"
          role="menu"
          aria-label={menuSession ? "会话操作菜单" : "项目操作菜单"}
          ref={contextRef}
          style={{ left: context.x, top: context.y }}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              contextRef.current?.querySelectorAll<HTMLButtonElement>(
                "button",
              ) || [],
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          <button role="menuitem" onClick={() => action("rename")}>
            重命名
          </button>
          {menuSession && (
            <button role="menuitem" onClick={() => action("pin")}>
              {menuSession.pinned ? "取消置顶" : "置顶"}
            </button>
          )}
          <button role="menuitem" onClick={() => action("archive")}>
            {menuSession
              ? menuSession.archived
                ? "恢复会话"
                : "归档会话"
              : menuProject?.archived
                ? "恢复项目"
                : "归档项目"}
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => action("delete")}
          >
            {menuSession ? "删除会话" : "移除项目"}
          </button>
        </div>
      )}
    </>
  );
}

function SettingsPanel({
  state,
  tab,
  setTab,
  close,
  run: runGlobal,
  selected,
}: {
  state: HostState;
  tab: string;
  setTab: (v: string) => void;
  close: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  selected: string | null;
}) {
  const [feedback, setFeedback] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFeedback(null);
    await runGlobal(async () => {
      try {
        const value = await fn();
        setFeedback({ error: false, text: "操作完成" });
        return value;
      } catch (error) {
        setFeedback({
          error: true,
          text: errorText(error),
        });
        throw error;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    });
  };
  useEffect(() => {
    setFeedback(null);
  }, [tab]);
  const settingsContent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    settingsContent.current?.scrollTo({ top: 0 });
  }, [tab]);
  const [loginItem, setLoginItem] = useState(false);
  useEffect(() => {
    void window.bro
      .loginItem()
      .then(setLoginItem)
      .catch(() => {});
  }, []);
  const [editingConnection, setEditingConnection] = useState<string | null>(
    null,
  );
  const emptyConnection = {
    name: "",
    kind: "api",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "",
    contextWindow: "128000",
    maxTokens: "16384",
    api: "openai-completions",
    imageInput: true,
    reasoning: true,
  };
  const [connection, setConnection] = useState(emptyConnection);
  const [feishu, setFeishu] = useState({
    appId: state.feishu.appId || "",
    appSecret: "",
    botId: state.feishu.botId || "",
  });
  const [trusted, setTrusted] = useState(
    state.settings.trustedFeishuUsers.join("\n"),
  );
  const [subscription, setSubscription] = useState({
    name: "",
    kind: "sse",
    url: "",
    path: "",
    command: "",
    me: "",
    token: "",
    trustedSenders: "",
    targetSessionId: selected || "",
    enabled: true,
  });
  const [auth, setAuth] = useState<any>(null),
    [authAnswer, setAuthAnswer] = useState("");
  useEffect(() => {
    if (tab !== "模型" || connection.kind !== "chatgpt") return;
    let active = true;
    const refresh = () =>
      api("/auth/status")
        .then((v) => {
          if (active) setAuth(v);
        })
        .catch((e) => {
          if (active) setAuth({ error: String(e) });
        });
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tab, connection.kind]);
  const update = (k: string, v: string | boolean) =>
    setConnection((c) => ({ ...c, [k]: v }));
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        style={{ "--room-color": rooms[tab].color } as React.CSSProperties}
      >
        <aside>
          <div className="eyebrow">BASE CAMP</div>
          <h2>工作站设置</h2>
          {["模型", "飞书", "Monitor", "资源", "记忆与实验", "通用"].map(
            (t) => (
              <button
                className={tab === t ? "active" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                <PixelIcon kind={rooms[t].icon} />
                <span>{t}</span>
              </button>
            ),
          )}
        </aside>
        <div className="settings-content" ref={settingsContent}>
          <button
            className="modal-close icon-button"
            aria-label="关闭设置"
            onClick={close}
          >
            <Icon name="close" />
          </button>
          <div className="room-header">
            <div>
              <div className="eyebrow">{rooms[tab].code}</div>
              <h2>{tab}</h2>
              <p>{rooms[tab].title}</p>
            </div>
            <PixelScene variant={tab} />
          </div>
          {feedback && (
            <div
              role={feedback.error ? "alert" : "status"}
              className={`feedback ${feedback.error ? "failure" : "success"}`}
            >
              {feedback.text}
            </div>
          )}
          <fieldset
            className="settings-fields"
            disabled={saving}
            aria-busy={saving}
          >
            {tab === "模型" && (
              <>
                <p className="description">
                  连接 ChatGPT 账号，或使用自己的 API 服务。
                </p>
                {state.connections.map((c) => (
                  <div className="connection-card" key={c.id}>
                    <strong>{c.name}</strong>
                    <span>
                      {c.kind === "chatgpt"
                        ? "在对话中切换模型与思考强度"
                        : c.model}
                    </span>
                    <small>
                      {c.kind === "chatgpt" ? "ChatGPT 账号" : c.baseUrl}
                    </small>
                    <div className="card-actions">
                      <button
                        onClick={() => {
                          setEditingConnection(c.id);
                          setConnection({
                            name: c.name,
                            kind: c.kind,
                            baseUrl: c.baseUrl || "",
                            apiKey: "",
                            model: c.model,
                            contextWindow: String(c.contextWindow),
                            maxTokens: String(c.maxTokens),
                            api: c.api || "openai-completions",
                            imageInput: c.imageInput,
                            reasoning: c.reasoning,
                          });
                        }}
                      >
                        修改
                      </button>
                      <button
                        onClick={() =>
                          void run(() =>
                            api("/settings", "PATCH", {
                              defaultConnectionId: c.id,
                            }),
                          )
                        }
                      >
                        {state.settings.defaultConnectionId === c.id
                          ? "✓ 默认连接"
                          : "设为默认"}
                      </button>
                      <button
                        onClick={() =>
                          void run(async () => {
                            await api(`/connections/${c.id}`, "DELETE");
                            if (editingConnection === c.id)
                              setEditingConnection(null);
                          })
                        }
                      >
                        删除连接
                      </button>
                    </div>
                  </div>
                ))}
                {editingConnection && (
                  <div className="notice">
                    正在修改已有连接；API Key 留空保留原值。
                    <button
                      onClick={() => {
                        setEditingConnection(null);
                        setConnection(emptyConnection);
                      }}
                    >
                      改为新增连接
                    </button>
                  </div>
                )}
                <div className="segmented">
                  <button
                    className={connection.kind === "api" ? "active" : ""}
                    onClick={() => update("kind", "api")}
                  >
                    API Key
                  </button>
                  <button
                    className={connection.kind === "chatgpt" ? "active" : ""}
                    onClick={() => update("kind", "chatgpt")}
                  >
                    ChatGPT
                  </button>
                </div>
                {connection.kind === "chatgpt" ? (
                  <div>
                    <p className="description">
                      用你的 ChatGPT 账号登录，授权信息保存在本机。
                    </p>
                    {auth?.accounts?.length ? (
                      <div className="connection-card">
                        <strong>账号已连接</strong>
                        <span>
                          {auth.accounts[0].email || auth.accounts[0].accountId}
                        </span>
                        <button
                          onClick={() =>
                            void run(() => api("/auth/logout", "POST", {}))
                          }
                        >
                          退出
                        </button>
                      </div>
                    ) : (
                      <button
                        className="primary"
                        onClick={() =>
                          void run(() => api("/auth/login", "POST", {}))
                        }
                      >
                        登录 ChatGPT
                      </button>
                    )}
                    {auth?.url && (
                      <button
                        className="secondary"
                        onClick={() =>
                          void run(() => window.bro.open(auth.url))
                        }
                      >
                        打开浏览器授权
                      </button>
                    )}
                    {auth?.instructions && (
                      <p className="description">{auth.instructions}</p>
                    )}
                    {auth?.error && <div className="notice">{auth.error}</div>}
                    {auth?.prompt && (
                      <>
                        <Field
                          label={auth.prompt}
                          value={authAnswer}
                          onChange={setAuthAnswer}
                        />
                        <button
                          className="secondary"
                          onClick={() =>
                            void run(() =>
                              api("/auth/answer", "POST", {
                                value: authAnswer,
                              }),
                            )
                          }
                        >
                          提交授权信息
                        </button>
                      </>
                    )}
                    <Field
                      label="连接名称"
                      value={connection.name}
                      onChange={(v) => update("name", v)}
                      placeholder="ChatGPT"
                    />
                    <p className="description">
                      保存账号后，在对话输入框旁选择模型和思考强度。
                    </p>
                    <button
                      className="primary"
                      disabled={
                        !auth?.accounts?.length || !auth?.models?.length
                      }
                      onClick={() =>
                        void run(async () => {
                          const initialModel =
                            auth.models.find(
                              (m: any) => m.id === connection.model,
                            ) || auth.models[0];
                          const saved = await api("/connections", "POST", {
                            ...connection,
                            ...initialModel,
                            id: editingConnection || undefined,
                            name: connection.name || "ChatGPT",
                            model: initialModel.id,
                            apiKey: undefined,
                          });
                          setEditingConnection(saved.id);
                        })
                      }
                    >
                      {editingConnection ? "保存修改" : "保存账号连接"}
                    </button>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const saved = await api("/connections", "POST", {
                          ...connection,
                          id: editingConnection || undefined,
                        });
                        setConnection((c) => ({ ...c, apiKey: "" }));
                        setEditingConnection(saved.id);
                      });
                    }}
                  >
                    <Field
                      label="连接名称"
                      value={connection.name}
                      onChange={(v) => update("name", v)}
                      placeholder="我的模型"
                    />
                    <Field
                      label="Base URL"
                      value={connection.baseUrl}
                      onChange={(v) => update("baseUrl", v)}
                    />
                    <Field
                      label="API Key"
                      type="password"
                      value={connection.apiKey}
                      onChange={(v) => update("apiKey", v)}
                    />
                    <Field
                      label="模型 ID"
                      value={connection.model}
                      onChange={(v) => update("model", v)}
                      placeholder="服务商提供的模型名称"
                    />
                    <label className="field">
                      接口协议
                      <select
                        value={connection.api}
                        onChange={(e) => update("api", e.target.value)}
                      >
                        <option value="openai-completions">
                          OpenAI Chat Completions
                        </option>
                        <option value="openai-responses">
                          OpenAI Responses
                        </option>
                        <option value="anthropic-messages">
                          Anthropic Messages
                        </option>
                      </select>
                    </label>
                    <Field
                      label="上下文窗口 tokens"
                      value={connection.contextWindow}
                      onChange={(v) => update("contextWindow", v)}
                    />
                    <Field
                      label="最大输出 tokens"
                      value={connection.maxTokens}
                      onChange={(v) => update("maxTokens", v)}
                    />
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={connection.imageInput}
                        onChange={(e) => update("imageInput", e.target.checked)}
                      />
                      支持图片输入
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={connection.reasoning}
                        onChange={(e) => update("reasoning", e.target.checked)}
                      />
                      支持推理强度
                    </label>
                    <button className="primary">
                      {editingConnection ? "保存修改" : "保存连接"}
                    </button>
                  </form>
                )}
              </>
            )}
            {tab === "飞书" && (
              <>
                <p className="description">
                  私聊连接一个会话；群聊按成员分别续接，被可信成员 @ 时才回复。
                </p>
                <div className="status-row">
                  <span
                    className={`status-dot ${state.feishu.connected ? "idle" : "error"}`}
                  />
                  {state.feishu.connected ? "连接已启动" : "尚未连接"}
                </div>
                {state.feishu.error && (
                  <div className="notice">{state.feishu.error}</div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() =>
                      api("/feishu", "POST", { ...feishu, enabled: true }),
                    );
                  }}
                >
                  <Field
                    label="App ID"
                    value={feishu.appId}
                    onChange={(v) => setFeishu((x) => ({ ...x, appId: v }))}
                  />
                  <Field
                    label="App Secret"
                    type="password"
                    value={feishu.appSecret}
                    onChange={(v) => setFeishu((x) => ({ ...x, appSecret: v }))}
                  />
                  <Field
                    label="Bot open_id（可留空自动获取）"
                    value={feishu.botId}
                    onChange={(v) => setFeishu((x) => ({ ...x, botId: v }))}
                  />
                  <button className="primary">保存并连接</button>
                </form>
                <hr />
                <h3>受信任的人</h3>
                <p className="description">
                  首次填写你自己的 open_id。每行一个；名单内均可完整使用 Bro。
                </p>
                <textarea
                  className="settings-textarea"
                  aria-label="受信任的飞书用户"
                  value={trusted}
                  onChange={(e) => setTrusted(e.target.value)}
                  placeholder="ou_…"
                />
                <button
                  className="secondary"
                  onClick={() =>
                    void run(() =>
                      api("/settings", "PATCH", {
                        trustedFeishuUsers: trusted
                          .split(/\s+/)
                          .filter(Boolean),
                      }),
                    )
                  }
                >
                  保存名单
                </button>
              </>
            )}
            {tab === "飞书" && <OutboxPanel run={run} />}
            {tab === "Monitor" && (
              <>
                <h3>入口绑定</h3>
                {!state.bindings.length && (
                  <p className="empty-note">
                    还没有入口绑定。连接消息来源后，它们会出现在这里。
                  </p>
                )}
                {state.bindings.map((b) => (
                  <label className="field" key={b.key}>
                    {b.key}
                    <select
                      value={b.sessionId}
                      onChange={(e) =>
                        void run(() =>
                          api("/bindings", "POST", {
                            key: b.key,
                            sessionId: e.target.value,
                          }),
                        )
                      }
                    >
                      {state.sessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <p className="description">
                  后台监听已配置的事件源，将新事件排入目标会话。无事件时不调用模型。
                </p>
                {state.subscriptions.map((s) => (
                  <div className="connection-card" key={s.id}>
                    <strong>{s.name}</strong>
                    <span>
                      {s.kind} · {s.enabled ? "已启用" : "已停用"}
                    </span>
                    {state.monitorErrors[s.id] && (
                      <small className="danger">
                        {state.monitorErrors[s.id]}
                      </small>
                    )}
                    <button
                      onClick={() =>
                        void run(() =>
                          api("/subscriptions", "POST", {
                            ...s,
                            enabled: !s.enabled,
                          }),
                        )
                      }
                    >
                      {s.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await api("/subscriptions", "POST", {
                        ...subscription,
                        command:
                          subscription.kind === "process"
                            ? JSON.parse(subscription.command)
                            : undefined,
                        trustedSenders: subscription.trustedSenders
                          .split(/\s+/)
                          .filter(Boolean),
                      });
                      setSubscription((s) => ({ ...s, name: "", token: "" }));
                    });
                  }}
                >
                  <Field
                    label="订阅名称"
                    value={subscription.name}
                    onChange={(v) =>
                      setSubscription((s) => ({ ...s, name: v }))
                    }
                  />
                  <label className="field">
                    来源
                    <select
                      value={subscription.kind}
                      onChange={(e) =>
                        setSubscription((s) => ({ ...s, kind: e.target.value }))
                      }
                    >
                      <option value="sse">SSE 事件</option>
                      <option value="peer">Peer Relay</option>
                      <option value="file">文件变化</option>
                      <option value="process">进程输出</option>
                    </select>
                  </label>
                  {["sse", "peer"].includes(subscription.kind) ? (
                    <Field
                      label="SSE 地址"
                      value={subscription.url}
                      onChange={(v) =>
                        setSubscription((s) => ({ ...s, url: v }))
                      }
                    />
                  ) : subscription.kind === "file" ? (
                    <Field
                      label="文件路径"
                      value={subscription.path}
                      onChange={(v) =>
                        setSubscription((s) => ({ ...s, path: v }))
                      }
                    />
                  ) : (
                    <Field
                      label="命令参数数组"
                      placeholder={'["程序", "参数"]'}
                      value={subscription.command}
                      onChange={(v) =>
                        setSubscription((s) => ({ ...s, command: v }))
                      }
                    />
                  )}
                  {subscription.kind === "peer" && (
                    <>
                      <Field
                        label="Bro 的 Peer 身份"
                        value={subscription.me}
                        onChange={(v) =>
                          setSubscription((s) => ({ ...s, me: v }))
                        }
                      />
                      <Field
                        label="Relay Token"
                        type="password"
                        value={subscription.token}
                        onChange={(v) =>
                          setSubscription((s) => ({ ...s, token: v }))
                        }
                      />
                      <Field
                        label="受信任的 Peer（空格分隔）"
                        value={subscription.trustedSenders}
                        onChange={(v) =>
                          setSubscription((s) => ({ ...s, trustedSenders: v }))
                        }
                      />
                    </>
                  )}
                  <label className="field">
                    目标会话
                    <select
                      value={subscription.targetSessionId}
                      onChange={(e) =>
                        setSubscription((s) => ({
                          ...s,
                          targetSessionId: e.target.value,
                        }))
                      }
                    >
                      <option value="">选择会话</option>
                      {state.sessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary"
                    disabled={
                      !subscription.name.trim() || !subscription.targetSessionId
                    }
                  >
                    添加监听
                  </button>
                </form>
              </>
            )}
            {tab === "资源" && <ResourcePanel state={state} run={run} />}
            {tab === "记忆与实验" && (
              <ExperimentPanel state={state} run={run} selected={selected} />
            )}
            {tab === "通用" && (
              <>
                <h3>工作目录</h3>
                <p className="description">
                  普通聊天和首次飞书会话使用此目录。
                </p>
                <div className="path-value">{state.settings.defaultCwd}</div>
                <button
                  className="secondary"
                  onClick={() =>
                    void run(async () => {
                      const path = await window.bro.directory();
                      if (path)
                        await api("/settings", "PATCH", { defaultCwd: path });
                    })
                  }
                >
                  更改目录
                </button>
                <hr />
                <h3>后台服务</h3>
                <label className="switch-row">
                  <span>登录电脑后启动后台</span>
                  <input
                    type="checkbox"
                    checked={loginItem}
                    onChange={(e) =>
                      void run(async () =>
                        setLoginItem(
                          await window.bro.loginItem(e.target.checked),
                        ),
                      )
                    }
                  />
                </label>
                <p className="description">
                  关闭窗口后，Monitor 和正在运行的任务继续工作。
                </p>
                <button
                  className="secondary"
                  onClick={() =>
                    void run(async () => {
                      const info = await api("/diagnostics");
                      await window.bro.open(info.dataRoot);
                    })
                  }
                >
                  打开数据目录
                </button>
                <hr />
                <button
                  className="secondary"
                  onClick={() => void run(() => window.bro.stopHost())}
                >
                  停止后台并退出（中断任务）
                </button>
                <hr />
                <h3>Computer Use</h3>
                <p className="description">
                  使用本机屏幕与辅助功能。检测到你操作键鼠时暂停，由你手动继续。首次使用需要系统权限。
                </p>
                <label className="switch-row">
                  <span>启用桌面操作</span>
                  <input
                    type="checkbox"
                    checked={state.settings.computer}
                    onChange={(e) =>
                      void run(() =>
                        api("/settings", "PATCH", {
                          computer: e.target.checked,
                        }),
                      )
                    }
                  />
                </label>
                <p className="description">{state.desktop.reason}</p>
                <button
                  className="secondary"
                  onClick={() => void run(() => api("/desktop"))}
                >
                  检测系统权限
                </button>
                {state.desktop.paused && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void run(() => api("/desktop/resume", "POST", {}))
                    }
                  >
                    手动继续桌面操作
                  </button>
                )}
                {state.desktop.capabilities && (
                  <div className="capabilities">
                    {(
                      [
                        ["屏幕截图", "capture"],
                        ["鼠标与键盘", "input"],
                        ["界面控件读取", "ax"],
                        ["后台窗口输入", "backgroundWindowInput"],
                        ["人工接管检测", "takeover"],
                      ] as const
                    ).map(([label, key]) => (
                      <div className="capability-row" key={key}>
                        <span>{label}</span>
                        <strong>
                          {state.desktop.capabilities?.[key]
                            ? "可用"
                            : "未就绪"}
                        </strong>
                      </div>
                    ))}
                    <details>
                      <summary>技术详情</summary>
                      <pre>
                        {JSON.stringify(state.desktop.capabilities, null, 2)}
                      </pre>
                    </details>
                  </div>
                )}
              </>
            )}
          </fieldset>
        </div>
      </section>
    </div>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
