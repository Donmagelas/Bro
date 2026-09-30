import React, { useEffect, useState } from "react";
import type { HostState } from "../../../../packages/contracts";
export function ExperimentPanel({
  state,
  run,
}: {
  state: HostState;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [settings, setSettings] = useState(state.settings.experiments),
    [key, setKey] = useState(""),
    [records, setRecords] = useState<any[]>([]);
  useEffect(() => {
    void window.bro
      .request("/experiments")
      .then(setRecords)
      .catch(() => {});
  }, []);
  return (
    <>
      <h3>实验策略</h3>
      <p className="description">
        三个环节独立切换。旁路比较记录选择结果，任务仍走常规流程。判断不可用时自动回退。压缩重点由判断模型选择，摘要仍由原模型生成。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await window.bro.request("/settings", "PATCH", {
              experiments: settings,
              ...(key ? { experimentKey: key } : {}),
            });
            setKey("");
          });
        }}
      >
        {(["skills", "context", "compression"] as const).map((stage, i) => (
          <label className="field" key={stage}>
            {["Skill 选择", "上下文选择", "压缩重点"][i]}
            <select
              value={settings[stage]}
              onChange={(e) =>
                setSettings((s) => ({ ...s, [stage]: e.target.value }))
              }
            >
              <option value="normal">常规</option>
              <option value="shadow">旁路比较</option>
              <option value="experimental">实验</option>
            </select>
          </label>
        ))}
        <label className="field">
          判断后端
          <select
            value={settings.backend}
            onChange={(e) =>
              setSettings((s) => ({ ...s, backend: e.target.value as any }))
            }
          >
            <option value="typesafe">Jev / TypeSafe</option>
            <option value="laya">Laya</option>
          </select>
        </label>
        <label className="field">
          服务根地址
          <input
            value={settings.endpoint}
            onChange={(e) =>
              setSettings((s) => ({ ...s, endpoint: e.target.value }))
            }
            placeholder="http://127.0.0.1:8000"
          />
        </label>
        <label className="field">
          模型
          <input
            value={settings.model}
            onChange={(e) =>
              setSettings((s) => ({ ...s, model: e.target.value }))
            }
            placeholder={
              settings.backend === "laya" ? "multilingual" : "jev-latest"
            }
          />
        </label>
        <label className="field">
          API Key（留空保留已存值）
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <button className="primary">保存策略</button>
      </form>
      {!!state.pendingRefresh.length && (
        <div className="notice">
          {state.pendingRefresh.length}{" "}
          个会话仍在使用此前配置，将在空闲边界刷新。
        </div>
      )}

      {!!records.length && (
        <>
          <hr />
          <h3>最近比较记录</h3>
          {records
            .slice(-8)
            .reverse()
            .map((r, i) => (
              <div className="connection-card" key={i}>
                <strong>
                  {r.stage} · {r.mode}
                </strong>
                <span>
                  {r.elapsedMs} ms · {r.selected?.length}/{r.candidates?.length}{" "}
                  段 · {r.applied ? "已采用" : "沿用常规"}
                </span>
                {r.fallback && <small>{r.fallback}</small>}
              </div>
            ))}
        </>
      )}
    </>
  );
}
