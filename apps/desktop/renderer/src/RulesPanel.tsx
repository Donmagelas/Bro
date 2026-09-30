import React, { useEffect, useState } from "react";
import type { HostState, RulesDocument } from "../../../../packages/contracts";

type Draft = { document: RulesDocument; text: string };

export function RulesPanel({
  state,
  active,
  onDirtyChange,
}: {
  state: HostState;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [scope, setScope] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const draft = drafts[scope];
  const dirty = Object.values(drafts).some(
    (d) => d.text !== d.document.content,
  );
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setMessage("");
    window.bro
      .request(
        `/rules${scope ? `?projectId=${encodeURIComponent(scope)}` : ""}`,
      )
      .then((document: RulesDocument) => {
        if (!cancelled)
          setDrafts((old) => {
            const existing = old[scope];
            // Keep unsaved work when switching pages or scopes; save detects disk conflicts.
            if (existing && existing.text !== existing.document.content)
              return old;
            return { ...old, [scope]: { document, text: document.content } };
          });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, active, reload]);

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const document: RulesDocument = await window.bro.request(
        "/rules",
        "PUT",
        {
          projectId: scope || null,
          content: draft.text,
          revision: draft.document.revision,
        },
      );
      setDrafts((old) => ({
        ...old,
        [scope]: { document, text: document.content },
      }));
      setMessage("已保存。会话空闲后，下一次消息会使用新规则。");
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <p className="description">
        全局规则用于所有会话，项目规则随该项目的工作目录一起加载。
      </p>
      <label className="field">
        作用范围
        <select
          value={scope}
          disabled={saving}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="">全局规则</option>
          {state.projects.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {draft && <div className="path-value">{draft.document.path}</div>}
      {error && (
        <p role="alert" className="feedback failure">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="feedback success">
          {message}
        </p>
      )}
      <label className="field">
        AGENTS.md
        {draft && draft.text !== draft.document.content ? " · 未保存" : ""}
        <textarea
          className="settings-textarea rules-editor"
          spellCheck={false}
          value={draft?.text || ""}
          disabled={loading || saving || !draft}
          placeholder={
            loading
              ? "正在读取…"
              : "写下希望 Bro 遵守的约定，例如：默认用中文回答。"
          }
          onChange={(e) =>
            setDrafts((old) => ({
              ...old,
              [scope]: { ...old[scope]!, text: e.target.value },
            }))
          }
        />
      </label>
      <div className="directory-actions">
        <button
          className="primary"
          disabled={
            loading || saving || !draft || draft.text === draft.document.content
          }
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存规则"}
        </button>
        <button
          disabled={loading || saving}
          onClick={() => {
            if (
              draft &&
              draft.text !== draft.document.content &&
              !window.confirm("重新读取会丢弃此范围内未保存的编辑，继续吗？")
            )
              return;
            setDrafts((old) => {
              const next = { ...old };
              delete next[scope];
              return next;
            });
            setReload((v) => v + 1);
          }}
        >
          重新读取
        </button>
      </div>
      {!!state.pendingRefresh.length && (
        <p className="description">
          {state.pendingRefresh.length}{" "}
          个会话将在当前任务及后台操作结束后应用新配置。
        </p>
      )}
    </>
  );
}
