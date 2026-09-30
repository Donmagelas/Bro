import React, { useState } from "react";
import type { HostState } from "../../../../packages/contracts";
import { PixelIcon } from "./PixelScene";

const api = (path: string, body: unknown) =>
  window.bro.request(path, "POST", body);

export function FeishuPanel({
  state,
  run,
  openSession,
}: {
  state: HostState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  openSession: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    appId: state.feishu.appId || "",
    appSecret: "",
    botId: state.feishu.botId || "",
    trusted: state.settings.trustedFeishuUsers.join("\n"),
  });
  const sessions = state.sessions.filter((s) => !s.archived);
  const feishuEnabled = state.feishu.enabled ?? state.feishu.configured;
  const bindings = state.bindings.filter((b) =>
    b.key.startsWith(`feishu:${state.feishu.appId}:`),
  );
  const update = (key: keyof typeof draft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
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
  const toggleFeishu = () =>
    run(() =>
      api("/feishu", {
        appId: state.feishu.appId,
        botId: state.feishu.botId,
        enabled: !feishuEnabled,
      }),
    );
  return (
    <div className="monitor-panel">
      {state.feishu.configured && (
        <article className="monitor-connection" aria-label="飞书连接">
          <div className="monitor-connection-header">
            <div className="monitor-source-icon">
              <PixelIcon kind="mail" />
            </div>
            <div className="monitor-connection-name">
              <h3>飞书</h3>
              <span>机器人私聊与群聊</span>
            </div>
            <span
              className={`monitor-status ${!feishuEnabled ? "off" : state.feishu.error ? "error" : ""}`}
            >
              {!feishuEnabled
                ? "已停用"
                : state.feishu.error
                  ? "连接异常"
                  : state.feishu.connected
                    ? "已连接"
                    : "连接中"}
            </span>
          </div>
          {feishuEnabled && state.feishu.error && (
            <p role="status" className="notice">
              {state.feishu.error}
            </p>
          )}
          <div className="monitor-card-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => void toggleFeishu()}
            >
              {feishuEnabled ? "停用" : "启用"}
            </button>
          </div>
        </article>
      )}

      <details className="monitor-section" open={!state.feishu.configured}>
        <summary>连接配置</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/feishu", {
                appId: draft.appId.trim(),
                appSecret: draft.appSecret,
                botId:
                  draft.appId.trim() === state.feishu.appId ? draft.botId : "",
                enabled: state.feishu.configured ? feishuEnabled : true,
              });
              update("appSecret", "");
            });
          }}
        >
          {field("App ID", "appId", { required: true })}
          {field("App Secret", "appSecret", {
            type: "password",
            placeholder: state.feishu.configured
              ? "留空保留已保存的密钥"
              : "填写应用密钥",
            required:
              !state.feishu.configured ||
              draft.appId.trim() !== state.feishu.appId,
          })}
          <details className="monitor-technical">
            <summary>高级设置</summary>
            {field("机器人 open_id", "botId", {
              placeholder: "留空自动获取",
            })}
          </details>
          <button className="primary">
            {state.feishu.configured ? "保存配置" : "保存并连接"}
          </button>
        </form>
      </details>
      <details
        className="monitor-section"
        open={!state.settings.trustedFeishuUsers.length}
      >
        <summary>
          受信任的人 · {state.settings.trustedFeishuUsers.length} 人
        </summary>
        <p className="description">
          名单内的人可以使用 Bro。填写此应用下的用户 open_id，每行一个。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              window.bro.request("/settings", "PATCH", {
                trustedFeishuUsers: draft.trusted.split(/\s+/).filter(Boolean),
              }),
            );
          }}
        >
          <label className="field">
            受信任的飞书用户
            <textarea
              className="settings-textarea"
              value={draft.trusted}
              placeholder="ou_…"
              onChange={(e) => update("trusted", e.target.value)}
            />
          </label>
          <button className="secondary">保存名单</button>
        </form>
      </details>
      <section className="monitor-section">
        <h3>消息与会话</h3>
        <div className="monitor-routing-rule">
          <p>
            <strong>私聊</strong>
            <span>每位联系人使用自己的会话。</span>
          </p>
          <p>
            <strong>群聊</strong>
            <span>可信成员 @ 才处理，同一群按成员分别续接会话。</span>
          </p>
        </div>
        {!bindings.length && (
          <p className="empty-note">
            收到第一条有效消息后，会自动创建并连接会话。
          </p>
        )}
        {bindings.map((binding, index) => (
          <div className="monitor-route" key={binding.key}>
            <label className="field">
              {binding.key.startsWith(`feishu:${state.feishu.appId}:dm:`)
                ? "私聊"
                : "群聊"}
              入口 {index + 1}
              <select
                aria-label={`入口 ${index + 1} 的会话`}
                value={binding.sessionId}
                onChange={(e) =>
                  void run(() =>
                    api("/bindings", {
                      key: binding.key,
                      sessionId: e.target.value,
                    }),
                  )
                }
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => openSession(binding.sessionId)}
            >
              打开会话
            </button>
            <details className="monitor-technical">
              <summary>入口标识</summary>
              <code>{binding.key}</code>
            </details>
          </div>
        ))}
      </section>
    </div>
  );
}
