import { useState } from "react";
import type { Annotation, Attachment } from "../../../../packages/contracts";
type Draft = {
  text: string;
  attachments: Attachment[];
  annotations: Annotation[];
};
const empty: Draft = { text: "", attachments: [], annotations: [] };
const storageKey = "bro.drafts.v1";
export function useDrafts(sessionId: string | null) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {
      return {};
    }
  });
  const key = sessionId || "new";
  const draft = drafts[key] || empty;
  function update<K extends keyof Draft>(
    field: K,
    value: Draft[K] | ((old: Draft[K]) => Draft[K]),
  ) {
    setDrafts((old) => {
      const previous = old[key] || empty;
      const next = {
        ...old,
        [key]: {
          ...previous,
          [field]: typeof value === "function" ? value(previous[field]) : value,
        },
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* Retain in memory if storage is full. */
      }
      return next;
    });
  }
  return {
    draft: draft.text,
    setDraft: (value: string) => update("text", value),
    attachments: draft.attachments,
    setAttachments: (
      value: Attachment[] | ((old: Attachment[]) => Attachment[]),
    ) => update("attachments", value),
    annotations: draft.annotations,
    setAnnotations: (
      value: Annotation[] | ((old: Annotation[]) => Annotation[]),
    ) => update("annotations", value),
  };
}
