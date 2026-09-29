import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../contracts";
import {
  contextCandidates,
  createJudge,
  select,
  type SelectionRecord,
} from "./selection";

export function experimentExtension(
  root: string,
  sessionId: string,
  settings: Settings["experiments"],
  key: string,
  skills: any[],
) {
  if (
    Object.values({
      skills: settings.skills,
      context: settings.context,
      compression: settings.compression,
    }).every((v) => v === "normal")
  )
    return undefined;
  const judge = createJudge(settings, key);
  const record = (r: SelectionRecord) => {
    mkdirSync(join(root, "experiments"), { recursive: true });
    appendFileSync(
      join(root, "experiments", `${sessionId}.jsonl`),
      JSON.stringify(r) + "\n",
    );
  };
  let task = "";
  return (api: any) => {
    api.on("before_agent_start", async (event: any) => {
      task = event.prompt;
      if (settings.skills === "normal") return;
      const candidates = skills
        .filter((s) => !s.hide)
        .map((s, i) => ({
          id: `skill_${i}`,
          text: `${s.name}: ${s.description}`,
          required:
            task.includes(`/skill:${s.name}`) || task.includes(`$${s.name}`),
        }));
      const picked = await select(
        "skills",
        settings.skills,
        task,
        candidates,
        judge,
        record,
      );
      if (settings.skills !== "experimental" || picked === candidates) return;
      const names = new Set(picked.map((c) => c.text.split(": ")[0]));
      // Limit only the advertised catalog for this turn. The complete loaded
      // skills remain reachable for explicit invocation and later turns.
      return {
        systemPrompt: event.systemPrompt.map((part: string) =>
          part.replace(
            /<skills>\n[\s\S]*?\n<\/skills>/g,
            `<skills>\n${skills
              .filter((s) => names.has(s.name))
              .map((s) => `- ${s.name}: ${s.description}`)
              .join("\n")}\n</skills>`,
          ),
        ),
      };
    });
    if (settings.context !== "normal")
      api.on("context", async (event: any) => {
        const { candidates, groups } = contextCandidates(event.messages);
        const picked = await select(
          "context",
          settings.context,
          task,
          candidates,
          judge,
          record,
          event.signal,
        );
        if (settings.context !== "experimental" || picked === candidates)
          return;
        const keep = new Set(picked.map((c) => c.id));
        const remove = new Set(
          groups.flatMap((indices, i) =>
            keep.has(`exchange_${i}`) ? [] : indices,
          ),
        );
        return {
          messages: event.messages.filter(
            (_m: any, i: number) => !remove.has(i),
          ),
        };
      });
    // Using session.compacting preserves OMP's ordinary summary generator and
    // speculative-compaction branch. No session_before_compact hook is installed.
    if (settings.compression !== "normal")
      api.on("session.compacting", async (event: any) => {
        const candidates = event.messages.map((m: any, i: number) => ({
          id: `message_${i}`,
          text: JSON.stringify(m),
          required: ["user", "custom"].includes(m.role),
        }));
        const picked = await select(
          "compression",
          settings.compression,
          task,
          candidates,
          judge,
          record,
        );
        if (settings.compression !== "experimental" || picked === candidates)
          return;
        return {
          context: [
            "以下原始记录经实验策略选为摘要重点；保留事实及未完成事项，不忽略其他明确约束。",
            ...picked.map((c) => c.text),
          ],
          preserveData: { broSelection: picked.map((c) => c.id) },
        };
      });
  };
}
