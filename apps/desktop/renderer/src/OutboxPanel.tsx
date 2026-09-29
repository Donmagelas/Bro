import React, { useEffect, useState } from "react";
export function OutboxPanel({
  run,
}: {
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const refresh = () => window.bro.request("/outbox").then(setRows);
  useEffect(() => {
    void refresh().catch(() => {});
  }, []);
  const pending = rows.filter((r) =>
    ["failed", "uncertain", "pending"].includes(r.status),
  );
  return (
    <>
      <hr />
      <h3>回复投递</h3>
      <p className="description">
        发送结果不明时先核对 IM 收件端，避免重复回复。
      </p>
      <button className="secondary" onClick={() => void run(refresh)}>
        刷新
      </button>
      {pending.map((r) => (
        <div className="connection-card" key={r.id}>
          <strong>
            {r.status === "uncertain"
              ? "待核对"
              : r.status === "failed"
                ? "发送失败"
                : "待发送"}
          </strong>
          <small>{r.error || r.id}</small>
          {r.status !== "pending" && (
            <button
              onClick={() =>
                void run(async () => {
                  await window.bro.request("/outbox/retry", "POST", {
                    id: r.id,
                    verifiedMissing: r.status === "uncertain",
                  });
                  await refresh();
                })
              }
            >
              {r.status === "uncertain" ? "已核对未收到，重新发送" : "重新发送"}
            </button>
          )}
        </div>
      ))}
    </>
  );
}
