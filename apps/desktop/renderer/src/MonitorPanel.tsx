import React, { useState } from "react";
import type { HostState, Subscription } from "../../../../packages/contracts";
import { PixelIcon } from "./PixelScene";

type SourceKind = Subscription["kind"];
const sources: {
  kind: SourceKind;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    kind: "peer",
    label: "Peer",
    description: "连接本机或远端的 Peer",
    icon: "radar",
  },
  {
    kind: "file",
    label: "文件变化",
    description: "文件更新后交给 Bro 处理",
    icon: "box",
  },
  {
    kind: "process",
    label: "进程输出",
    description: "接收本机程序输出的事件",
    icon: "chip",
  },
  {
    kind: "sse",
    label: "SSE 事件",
    description: "接收自定义服务的事件",
    icon: "radar",
  },
];
const sourceOf = (kind: SourceKind) => sources.find((s) => s.kind === kind)!;
const api = (path: string, body: unknown) =>
  window.bro.request(path, "POST", body);

export function MonitorPanel({
  state,
  run,
  selected,
  openSession,
}: {
  state: HostState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  selected: string | null;
  openSession: (id: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [editor, setEditor] = useState<SourceKind | null>(null);
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    url: "",
    path: "",
    command: "",
    me: "",
    token: "",
    trustedSenders: "",
    targetSessionId: "",
    enabled: true,
  });
  const sessions = state.sessions.filter((s) => !s.archived);
  const available = sources.filter(
    (source) => !state.subscriptions.some((s) => s.kind === source.kind),
  );
  const update = (key: keyof typeof draft, value: string | boolean) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const back = () => {
    setEditor(null);
    setChoosing(false);
    setDraft((d) => ({ ...d, token: "" }));
  };
  const edit = (kind: SourceKind, sub?: Subscription) => {
    setChoosing(false);
    setDraft({
      id: sub?.id || "",
      name: sub?.name || sourceOf(kind).label,
      url: sub?.url || "",
      path: sub?.path || "",
      command: sub?.command ? JSON.stringify(sub.command) : "",
      me: sub?.me || "",
      token: "",
      trustedSenders: sub?.trustedSenders?.join("\n") || "",
      targetSessionId:
        sub?.targetSessionId ||
        (sessions.some((s) => s.id === selected) ? selected! : ""),
      enabled: sub?.enabled ?? true,
    });
    setEditor(kind);
  };
  const field = (
    label: string,
    key: keyof typeof draft,
    options: { type?: string; placeholder?: string; required?: boolean } = {},
  ) => (
    <label className="field">
      {label}
      <input
        type={options.type || "text"}
        value={String(draft[key])}
        onChange={(e) => update(key, e.target.value)}
        placeholder={options.placeholder}
        required={options.required}
        autoComplete={options.type === "password" ? "new-password" : undefined}
      />
    </label>
  );
  const targetName = (id: string) =>
    sessions.find((s) => s.id === id)?.title || "目标会话不可用，请重新选择";

  if (editor)
    return (
      <div className="monitor-editor">
        <button type="button" className="secondary monitor-back" onClick={back}>
          ← 返回监听列表
        </button>
        <div className="monitor-editor-title">
          <PixelIcon kind={sourceOf(editor).icon} />
          <h3>{sourceOf(editor).label}</h3>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              let command: string[] | undefined;
              if (editor === "process") {
                try {
                  command = JSON.parse(draft.command);
                } catch {
                  throw new Error('命令格式应为 ["程序", "参数"]');
                }
              }
              await api("/subscriptions", {
                id: draft.id || undefined,
                kind: editor,
                name: draft.name.trim(),
                enabled: draft.enabled,
                targetSessionId: draft.targetSessionId,
                url: draft.url,
                path: draft.path,
                command,
                me: draft.me.trim(),
                token: draft.token,
                trustedSenders: draft.trustedSenders
                  .split(/\s+/)
                  .filter(Boolean),
              });
              back();
            });
          }}
        >
          <section className="monitor-section">
            <h3>监听配置</h3>
            {field("名称", "name", { required: true })}
            {(editor === "peer" || editor === "sse") &&
              field(editor === "peer" ? "Relay 地址" : "事件服务地址", "url", {
                placeholder: "https://…",
                required: true,
              })}
            {editor === "file" &&
              field("文件路径", "path", {
                placeholder: "/path/to/file",
                required: true,
              })}
            {editor === "process" &&
              field("程序与参数", "command", {
                placeholder: '["程序", "参数"]',
                required: true,
              })}
            {editor === "peer" && (
              <>
                {field("Bro 的 Peer 身份", "me", { required: true })}
                {field("Relay Token", "token", {
                  type: "password",
                  placeholder: draft.id
                    ? "留空保留已保存的 Token"
                    : "填写 Relay Token",
                })}
                <label className="field">
                  受信任的 Peer
                  <textarea
                    className="settings-textarea"
                    value={draft.trustedSenders}
                    placeholder="每行一个 Peer 身份"
                    required
                    onChange={(e) => update("trustedSenders", e.target.value)}
                  />
                </label>
              </>
            )}
          </section>
          <section className="monitor-section">
            <h3>消息与会话</h3>
            <label className="field">
              收到消息后交给
              <select
                value={draft.targetSessionId}
                required
                onChange={(e) => update("targetSessionId", e.target.value)}
              >
                <option value="">选择会话</option>
                {!!draft.targetSessionId &&
                  !sessions.some((s) => s.id === draft.targetSessionId) && (
                    <option value={draft.targetSessionId} disabled>
                      原会话已删除或归档，请重新选择
                    </option>
                  )}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            {!sessions.length && (
              <p className="empty-note">
                先在 Bro 中创建一个会话，再选择接收消息的会话。
              </p>
            )}
            <p className="description">
              新消息进入该会话的队列。
              {editor === "peer"
                ? "回复返回消息来源。"
                : "结果保留在该会话中。"}
            </p>
          </section>
          <div className="monitor-editor-actions">
            <button
              className="primary"
              disabled={!sessions.some((s) => s.id === draft.targetSessionId)}
            >
              {draft.id ? "保存修改" : "添加监听"}
            </button>
            <button type="button" className="secondary" onClick={back}>
              取消
            </button>
          </div>
        </form>
      </div>
    );

  return (
    <div className="monitor-panel">
      <div className="monitor-toolbar">
        <h3>监听来源</h3>
        {!!available.length && !!state.subscriptions.length && (
          <button
            className="primary"
            type="button"
            onClick={() => setChoosing(!choosing)}
          >
            {choosing ? "收起" : "添加监听"}
          </button>
        )}
      </div>
      {state.subscriptions.map((sub) => (
        <article
          className="monitor-connection"
          key={sub.id}
          aria-label={`${sub.name}监听`}
        >
          <div className="monitor-connection-header">
            <div className="monitor-source-icon">
              <PixelIcon kind={sourceOf(sub.kind).icon} />
            </div>
            <div className="monitor-connection-name">
              <h3>{sub.name}</h3>
              <span>{sourceOf(sub.kind).label}</span>
            </div>
            <span
              className={`monitor-status ${!sub.enabled ? "off" : state.monitorErrors[sub.id] ? "error" : ""}`}
            >
              {!sub.enabled
                ? "已停用"
                : state.monitorErrors[sub.id]
                  ? "监听异常"
                  : "已启用"}
            </span>
          </div>
          <p className="monitor-destination">
            消息交给<span>{targetName(sub.targetSessionId)}</span>
          </p>
          {sub.enabled && state.monitorErrors[sub.id] && (
            <p role="status" className="notice">
              {state.monitorErrors[sub.id]}
            </p>
          )}
          <div className="monitor-card-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => edit(sub.kind, sub)}
            >
              管理监听
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!sessions.some((s) => s.id === sub.targetSessionId)}
              onClick={() => openSession(sub.targetSessionId)}
            >
              打开会话
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() =>
                void run(() =>
                  api("/subscriptions", { ...sub, enabled: !sub.enabled }),
                )
              }
            >
              {sub.enabled ? "停用" : "启用"}
            </button>
          </div>
        </article>
      ))}
      {(choosing || !state.subscriptions.length) && (
        <section className="monitor-source-picker" aria-label="添加监听来源">
          <h3>选择监听来源</h3>
          <div>
            {available.map((source) => (
              <button
                type="button"
                key={source.kind}
                onClick={() => edit(source.kind)}
              >
                <PixelIcon kind={source.icon} />
                <strong>{source.label}</strong>
                <span>{source.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
