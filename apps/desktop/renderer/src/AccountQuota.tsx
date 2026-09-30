import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatGPTQuota } from "../../../../packages/contracts";

export function AccountQuota({ connectionId }: { connectionId: string }) {
  const [quota, setQuota] = useState<ChatGPTQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(
    async (force = false) => {
      const request = ++sequence.current;
      setLoading(true);
      try {
        const result = await window.bro.request(
          `/auth/quota?connectionId=${encodeURIComponent(connectionId)}${force ? "&refresh=1" : ""}`,
        );
        if (sequence.current === request) setQuota(result);
      } catch {
        if (sequence.current === request)
          setQuota({
            status: "unavailable",
            checkedAt: Date.now(),
            accounts: [],
          });
      } finally {
        if (sequence.current === request) setLoading(false);
      }
    },
    [connectionId],
  );
  useEffect(() => {
    void refresh();
    const poll = () => {
      if (!document.hidden) void refresh();
    };
    const interval = window.setInterval(poll, 60000);
    window.addEventListener("focus", poll);
    const unsubscribe = window.bro.onEvent((event) => {
      if (event.type === "state" || event.type === "connected") poll();
    });
    return () => {
      sequence.current++;
      clearInterval(interval);
      window.removeEventListener("focus", poll);
      unsubscribe();
    };
  }, [refresh]);
  return (
    <section className="account-quota" aria-label="ChatGPT 剩余额度">
      <div className="quota-heading">
        <span>ChatGPT 剩余额度</span>
        <button
          aria-label="刷新账号额度"
          disabled={loading}
          onClick={() => void refresh(true)}
          title={
            quota
              ? `更新于 ${new Date(quota.checkedAt).toLocaleTimeString()}`
              : "刷新"
          }
        >
          ↻
        </button>
      </div>
      {!quota ? (
        <div className="quota-note">正在读取…</div>
      ) : quota.status === "signed_out" ? (
        <div className="quota-note">请先登录 ChatGPT</div>
      ) : quota.status === "unavailable" ? (
        <div className="quota-note">额度暂不可用，点击刷新重试</div>
      ) : (
        quota.accounts.map((account) => (
          <div className="quota-account" key={account.id}>
            {quota.accounts.length > 1 && (
              <div className="quota-email">
                {account.email || "ChatGPT 账号"}
              </div>
            )}
            {!account.updatedAt && (
              <div className="quota-note">额度暂不可用</div>
            )}
            {account.windows.map((window) => {
              const remaining = window.remainingPercent;
              const expired =
                window.resetsAt !== null && window.resetsAt <= Date.now();
              const known = remaining !== null && !expired;
              return (
                <div
                  className={`quota-window${known && remaining <= 10 ? " low" : ""}`}
                  key={window.id}
                >
                  <div className="quota-line">
                    <span>{window.label}</span>
                    <strong>{known ? `${Math.floor(remaining)}%` : "—"}</strong>
                  </div>
                  {known && (
                    <progress
                      aria-label={`${window.label}剩余额度`}
                      max={100}
                      value={remaining}
                    />
                  )}
                  {window.resetsAt !== null && (
                    <div className="quota-note">
                      {expired
                        ? "等待额度更新"
                        : `${new Date(window.resetsAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} 重置`}
                    </div>
                  )}
                </div>
              );
            })}
            {account.credits?.unlimited ? (
              <div className="quota-note">额外额度不限量</div>
            ) : account.credits?.balance !== null &&
              account.credits?.balance !== undefined &&
              account.credits.balance > 0 ? (
              <div className="quota-note">
                额外额度 {account.credits.balance.toLocaleString()} credits
              </div>
            ) : null}
            {account.updatedAt &&
            !account.windows.length &&
            !account.credits?.unlimited &&
            !(account.credits?.balance && account.credits.balance > 0) ? (
              <div className="quota-note">服务端未提供额度数据</div>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
