import React, { useEffect, useId, useState } from "react";
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
  run: (fn: () => Promise<unknown>, success?: string | null) => Promise<void>;
  openSession: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    appId: state.feishu.appId || "",
    appSecret: "",
    botId: state.feishu.botId || "",
  });
  const [trustedUser, setTrustedUser] = useState("");
  const [trustedError, setTrustedError] = useState("");
  const [trustedBusy, setTrustedBusy] = useState(false);
  const trustedInputId = useId();
  const trustedErrorId = useId();
  const [setupBusy, setSetupBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const pairingHelpId = useId();
  const setup = state.feishu.setup || { status: "idle" };
  const [trustedOpen, setTrustedOpen] = useState(
    state.feishu.configured &&
      !state.settings.trustedFeishuUsers.length &&
      setup.status !== "pairing",
  );
  const activeSetup = ["starting", "waiting", "connecting"].includes(
    setup.status,
  );
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      appId: state.feishu.appId || "",
      appSecret: "",
      botId: state.feishu.botId || "",
    }));
  }, [state.feishu.appId, state.feishu.botId]);
  useEffect(() => {
    setTrustedUser("");
    setTrustedError("");
  }, [state.feishu.appId]);
  const setupAction = async (action: string, body: unknown = {}) => {
    setSetupBusy(true);
    try {
      await run(() => api(`/feishu/setup/${action}`, body), null);
    } finally {
      setSetupBusy(false);
    }
  };
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
  const saveTrustedUsers = async (users: string[], adding = false) => {
    if (trustedBusy) return;
    setTrustedBusy(true);
    try {
      await run(
        async () => {
          await window.bro.request("/settings", "PATCH", {
            trustedFeishuUsers: users,
          });
          if (adding) setTrustedUser("");
          setTrustedError("");
        },
        adding ? "已添加受信任的用户" : "已移除用户",
      );
    } finally {
      setTrustedBusy(false);
    }
  };
  const addTrustedUser = () => {
    const id = trustedUser.trim();
    if (!/^ou_[a-zA-Z0-9_-]+$/.test(id)) {
      setTrustedError("请输入一个有效的飞书 open_id，以 ou_ 开头。");
      return;
    }
    if (state.settings.trustedFeishuUsers.includes(id)) {
      setTrustedError("这个用户已在名单中，无需重复添加。");
      return;
    }
    void saveTrustedUsers([...state.settings.trustedFeishuUsers, id], true);
  };
  return (
    <div className="monitor-panel">
      <section
        className="monitor-section feishu-setup"
        aria-label="扫码创建飞书应用"
      >
        <h3>扫码创建并连接</h3>
        {setup.status === "waiting" && setup.verificationUrl ? (
          <>
            <p>
              用飞书扫码，在官方页面完成创建。确认后 Bro
              会自动连接，并将创建人设为受信任的人，通常无需发送配对码。
            </p>
            <img
              className="feishu-qr"
              src={setup.qrCode}
              alt="飞书创建应用二维码"
            />
            <div className="monitor-card-actions">
              <button
                className="secondary"
                onClick={() =>
                  void run(() => window.bro.open(setup.verificationUrl!))
                }
              >
                打开授权页面
              </button>
              <button
                className="secondary"
                disabled={setupBusy}
                onClick={() => void setupAction("cancel")}
              >
                取消创建
              </button>
            </div>
            <p className="description" role="status">
              等待飞书确认 · 有效至{" "}
              {setup.expiresAt
                ? new Date(setup.expiresAt).toLocaleTimeString()
                : "—"}
            </p>
          </>
        ) : activeSetup ? (
          <>
            <p role="status">
              {setup.status === "starting"
                ? "正在准备二维码…"
                : "应用已创建，正在检查并连接机器人…"}
            </p>
            <button
              className="secondary"
              disabled={setupBusy}
              onClick={() => void setupAction("cancel")}
            >
              取消
            </button>
          </>
        ) : setup.status === "pairing" ? (
          <>
            <p>
              在飞书私聊这个机器人，发送以下配对码。绑定后仅发送该配对码的账号受信任，配对消息不会交给模型执行。
            </p>
            <div className="feishu-pairing-row">
              <code className="feishu-pairing-code">{setup.pairingCode}</code>
              <span className="feishu-pairing-help">
                <button
                  type="button"
                  className="feishu-help-button"
                  aria-label="为什么需要配对码？"
                  aria-describedby={pairingHelpId}
                >
                  ?
                </button>
                <span
                  id={pairingHelpId}
                  role="tooltip"
                  className="feishu-help-tooltip"
                >
                  通常扫码确认后，Bro 会自动连接并信任创建人，无需发送配对码。
                  <br />
                  只有未获取到创建人身份，或你选择重新绑定本人时，才需要私聊机器人发送此码。
                  <br />
                  配对码 10 分钟内有效，使用一次即失效。
                </span>
              </span>
            </div>
            <p className="description">
              有效至{" "}
              {setup.pairingExpiresAt
                ? new Date(setup.pairingExpiresAt).toLocaleTimeString()
                : "—"}
            </p>
            <button
              className="secondary"
              disabled={setupBusy}
              onClick={() => void setupAction("pair")}
            >
              重新生成配对码
            </button>
          </>
        ) : setup.status === "ready" ? (
          <>
            <p role="status">
              应用已保存，创建人已加入可信名单。可以去飞书给机器人发消息了。
            </p>
            <details className="monitor-technical">
              <summary>无法对话？重新绑定本人</summary>
              <p>生成一次性配对码，配对后可信名单仅保留该账号。</p>
              <button
                className="secondary"
                disabled={setupBusy}
                onClick={() => void setupAction("pair")}
              >
                生成配对码
              </button>
            </details>
            {state.feishu.error && (
              <button
                className="secondary"
                disabled={setupBusy}
                onClick={() => void setupAction("retry")}
              >
                重试连接
              </button>
            )}
          </>
        ) : (
          <>
            {setup.error && (
              <p className="notice" role="status">
                {setup.error}
              </p>
            )}
            {setup.status === "error" &&
            (setup.appId || setup.verificationUrl) ? (
              <button
                className="primary"
                disabled={setupBusy}
                onClick={() => void setupAction("retry")}
              >
                {setup.appId ? "继续连接已创建的应用" : "继续检查创建结果"}
              </button>
            ) : replace ? (
              <>
                <p>
                  新应用确认并校验成功后，将替换当前连接，可信名单重新绑定到创建人。原来的飞书会话记录保留。
                </p>
                <div className="monitor-card-actions">
                  <button
                    className="primary"
                    disabled={setupBusy}
                    onClick={() => {
                      setReplace(false);
                      void setupAction("start", { replace: true });
                    }}
                  >
                    创建新应用并替换
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setReplace(false)}
                  >
                    返回
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  用飞书扫码确认，自动完成应用配置和本人绑定，通常无需发送配对码。
                </p>
                <button
                  className="primary"
                  disabled={setupBusy}
                  onClick={() =>
                    state.feishu.configured
                      ? setReplace(true)
                      : void setupAction("start")
                  }
                >
                  {state.feishu.configured ? "创建新应用" : "扫码创建"}
                </button>
              </>
            )}
          </>
        )}
      </section>
      {state.feishu.configured && (
        <article
          className="monitor-connection feishu-connection"
          aria-label="飞书连接"
        >
          <div className="feishu-connection-header">
            <div className="monitor-source-icon">
              <PixelIcon kind="mail" />
            </div>
            <div className="monitor-connection-name">
              <h3>飞书</h3>
              <span>机器人私聊与群聊</span>
            </div>
            <div className="feishu-connection-actions">
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
              <button
                className="secondary"
                type="button"
                disabled={activeSetup || setupBusy}
                onClick={() => void toggleFeishu()}
              >
                {feishuEnabled ? "停用" : "启用"}
              </button>
            </div>
          </div>
          {feishuEnabled && state.feishu.error && (
            <p role="status" className="notice">
              {state.feishu.error}
            </p>
          )}
        </article>
      )}

      <details className="monitor-section">
        <summary>
          {state.feishu.configured ? "连接配置" : "连接已有应用"}
        </summary>
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
          <button className="primary" disabled={activeSetup || setupBusy}>
            {state.feishu.configured ? "保存配置" : "保存并连接"}
          </button>
        </form>
      </details>
      <details
        className="monitor-section feishu-trusted"
        open={trustedOpen}
        onToggle={(event) => setTrustedOpen(event.currentTarget.open)}
      >
        <summary>
          受信任的人 · {state.settings.trustedFeishuUsers.length} 人
        </summary>
        <p className="description">名单内的人可以通过飞书使用 Bro。</p>
        {state.settings.trustedFeishuUsers.length ? (
          <ul className="feishu-trusted-list" aria-label="受信任的飞书用户">
            {state.settings.trustedFeishuUsers.map((id) => (
              <li key={id}>
                <span className="feishu-user-icon" aria-hidden="true">
                  <PixelIcon kind="person" />
                </span>
                <code>{id}</code>
                <button
                  type="button"
                  className="feishu-remove-user"
                  aria-label={`移除用户 ${id}`}
                  disabled={trustedBusy || activeSetup || setupBusy}
                  onClick={() =>
                    void saveTrustedUsers(
                      state.settings.trustedFeishuUsers.filter(
                        (user) => user !== id,
                      ),
                    )
                  }
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-note">
            暂无受信任的用户，添加后即可通过飞书使用 Bro。
          </p>
        )}
        <form
          className="feishu-add-user"
          aria-label="添加受信任的用户"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            addTrustedUser();
          }}
        >
          <label className="field" htmlFor={trustedInputId}>
            用户 open_id
            <input
              id={trustedInputId}
              value={trustedUser}
              placeholder="输入此应用下的用户 ID，ou_ 开头"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!trustedError}
              aria-describedby={trustedError ? trustedErrorId : undefined}
              disabled={trustedBusy || activeSetup || setupBusy}
              onChange={(e) => {
                setTrustedUser(e.target.value);
                setTrustedError("");
              }}
            />
          </label>
          <button
            className="secondary"
            disabled={trustedBusy || activeSetup || setupBusy}
          >
            添加用户
          </button>
          {trustedError && (
            <p
              id={trustedErrorId}
              className="feishu-trusted-error"
              role="alert"
            >
              {trustedError}
            </p>
          )}
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
