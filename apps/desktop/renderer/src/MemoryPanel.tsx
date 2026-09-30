import React, { useState } from "react";
import type { HostState } from "../../../../packages/contracts";

export function MemoryPanel({
  state,
  run,
  selected,
}: {
  state: HostState;
  selected: string | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [memory, setMemory] = useState<any>(null),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any>(null);
  return (
    <>
      <h3>长期记忆</h3>
      <p className="description">
        使用 Mnemopi
        自动积累和检索。关闭后保留已有数据；当前轮及后台任务结束后应用更改。
      </p>
      <label className="switch-row">
        <span>Mnemopi</span>
        <input
          type="checkbox"
          checked={state.settings.memory}
          onChange={(e) =>
            void run(() =>
              window.bro.request("/settings", "PATCH", {
                memory: e.target.checked,
              }),
            )
          }
        />
      </label>
      {selected && (
        <>
          <button
            className="secondary"
            onClick={() =>
              void run(async () =>
                setMemory(
                  await window.bro.request(
                    `/sessions/${selected}/memory`,
                    "POST",
                    {},
                  ),
                ),
              )
            }
          >
            检查当前会话记忆状态
          </button>
          {memory && (
            <div className="notice">
              {memory.active ? "已启动" : "未启动"} ·{" "}
              {memory.message ||
                memory.error ||
                `${memory.workingCount || 0} 条工作记忆，${memory.episodicCount || 0} 条经历记忆`}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () =>
                setResults(
                  await window.bro.request(
                    `/sessions/${selected}/memory`,
                    "POST",
                    { query },
                  ),
                ),
              );
            }}
          >
            <label className="field">
              搜索当前会话可用记忆
              <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button disabled={!query.trim()}>搜索记忆</button>
          </form>
          {results && (
            <div className="connection-card">
              {results.message || `找到 ${results.count || 0} 条`}
              {results.items?.map((item: any, i: number) => (
                <p key={i}>{item.content}</p>
              ))}
            </div>
          )}
        </>
      )}
      {!!state.pendingRefresh.length && (
        <div className="notice">
          {state.pendingRefresh.length}{" "}
          个会话仍在使用此前配置，将在空闲边界刷新。
        </div>
      )}
    </>
  );
}
