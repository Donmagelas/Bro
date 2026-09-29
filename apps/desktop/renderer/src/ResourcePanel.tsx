import React, { useState } from "react";
import type { HostState } from "../../../../packages/contracts";
const api = (body: unknown) => window.bro.request("/resources", "POST", body);
export function ResourcePanel({
  state,
  run,
}: {
  state: HostState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState("skill"),
    [source, setSource] = useState(""),
    [name, setName] = useState(""),
    [scope, setScope] = useState("");
  const [config, setConfig] = useState(
      '{\n  "command": "npx",\n  "args": []\n}',
    ),
    [working, setWorking] = useState(false);
  const action = (data: unknown | (() => unknown)) =>
    run(async () => {
      setWorking(true);
      try {
        return await api(typeof data === "function" ? data() : data);
      } finally {
        setWorking(false);
      }
    });
  return (
    <>
      <p className="description">
        安装本机或 Git 来源的 Skill、OMP 插件，以及 MCP
        服务。配置在会话空闲且后台任务结束后生效。
      </p>
      {!!state.pendingRefresh.length && (
        <div className="notice">
          {state.pendingRefresh.length} 个会话等待应用新配置。
        </div>
      )}
      {state.resources.map((r) => (
        <div className="connection-card" key={r.id}>
          <strong>{r.name}</strong>
          <span>
            {r.kind} · {r.enabled ? "已启用" : "已停用"} ·{" "}
            {r.projectId
              ? state.projects.find((p) => p.id === r.projectId)?.name
              : "所有项目"}
          </span>
          <small>
            {r.source} {r.version}
          </small>
          <div>
            <button
              disabled={working}
              onClick={() =>
                void action({ id: r.id, action: "toggle", enabled: !r.enabled })
              }
            >
              {r.enabled ? "停用" : "启用"}
            </button>
            {r.kind !== "mcp" && (
              <button
                disabled={working}
                onClick={() => void action({ id: r.id, action: "update" })}
              >
                更新
              </button>
            )}
            <button
              disabled={working}
              onClick={() => void action({ id: r.id, action: "remove" })}
            >
              卸载
            </button>
          </div>
        </div>
      ))}
      {Object.entries(state.runtimeInfo)
        .filter(([, info]) => !!info)
        .map(([id, info]) => (
          <details className="connection-card" key={id}>
            <summary>
              {state.sessions.find((s) => s.id === id)?.title || id} ·
              最近加载记录
            </summary>
            <small>
              {new Date(info!.at).toLocaleString()}
              {state.pendingRefresh.includes(id) ? " · 等待刷新" : ""}
            </small>
            <p>Skill：{info!.skills.map((s) => s.name).join("、") || "无"}</p>
            <p>已连接 MCP：{info!.mcp.join("、") || "无"}</p>
            <details>
              <summary>{info!.tools.length} 个可用工具</summary>
              <small>{info!.tools.join("、")}</small>
            </details>
            {info!.warnings.map((warning, n) => (
              <p className="danger" key={n}>
                {typeof warning === "string"
                  ? warning
                  : JSON.stringify(warning)}
              </p>
            ))}
          </details>
        ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(() => ({
            kind,
            source,
            name,
            projectId: scope || null,
            config: kind === "mcp" ? JSON.parse(config) : undefined,
          }));
        }}
      >
        <label className="field">
          资源类型
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="skill">Skill</option>
            <option value="plugin">OMP 插件</option>
            <option value="mcp">MCP</option>
          </select>
        </label>
        <label className="field">
          作用范围
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">所有项目</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {kind === "mcp" ? (
          <>
            <label className="field">
              服务名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-server"
              />
            </label>
            <label className="field">
              服务配置 JSON
              <textarea
                className="settings-textarea"
                value={config}
                onChange={(e) => setConfig(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="field">
            本机目录或 Git 来源
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={
                kind === "skill"
                  ? "/path/to/skills 或 https://…git"
                  : "/path/to/plugin 或 github:owner/repo"
              }
            />
          </label>
        )}
        <button className="primary" disabled={working}>
          {working ? "处理中…" : "安装 / 保存"}
        </button>
      </form>
    </>
  );
}
