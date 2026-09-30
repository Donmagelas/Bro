import { join, resolve } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
  realpathSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { Resource, RulesDocument } from "../../packages/contracts";
import type { Store } from "./store";

export class Resources {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private changed: () => Promise<void>,
  ) {}
  list() {
    return this.store.getConfig<Resource[]>("resources", []);
  }
  publicList() {
    return this.list().map(({ config, plugin, ...r }) => r);
  }
  rules(projectId: string | null = null): RulesDocument {
    const project = projectId
      ? this.store.projects().find((p) => p.id === projectId)
      : null;
    if (projectId && !project) throw new Error("项目不存在");
    const path = join(
      project?.path || join(this.store.root, "agent"),
      "AGENTS.md",
    );
    let content = "",
      exists = false;
    try {
      content = readFileSync(path, "utf8");
      exists = true;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      path,
      content,
      exists,
      revision: createHash("sha256")
        .update(JSON.stringify([path, exists, content]))
        .digest("hex"),
    };
  }
  async saveRules(data: any) {
    if (data.projectId != null && typeof data.projectId !== "string")
      throw new Error("项目 ID 无效");
    if (
      typeof data.content !== "string" ||
      Buffer.byteLength(data.content, "utf8") > 1024 * 1024
    )
      throw new Error("规则内容必须为文本且不超过 1 MB");
    const current = this.rules(data.projectId || null);
    if (data.revision !== current.revision)
      throw new Error(
        "AGENTS.md 已在其他地方修改，请重新读取后再保存；你的编辑仍保留在输入框中",
      );
    if (!data.projectId)
      mkdirSync(join(this.store.root, "agent"), { recursive: true });
    // Preserve existing symlinks and project file permissions when replacing content.
    const path = current.exists ? realpathSync(current.path) : current.path;
    const mode = current.exists
      ? statSync(path).mode & 0o777
      : data.projectId
        ? 0o644
        : 0o600;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, data.content, { mode });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    const saved = this.rules(data.projectId || null);
    await this.changed();
    return saved;
  }
  async mutate(data: any) {
    const action = async () => {
      const rows = this.list(),
        old = rows.find((r) => r.id === data.id);
      if (data.action === "remove") {
        if (!old) throw new Error("资源不存在");
        this.store.setConfig(
          "resources",
          rows.filter((r) => r.id !== old.id),
        );
        // Loaded modules can remain in use until a session reaches a safe boundary.
        // Keep the private cache so an in-flight operation cannot lose its files.
        await this.changed();
        return { removed: true };
      }
      if (old && data.action === "toggle") {
        old.enabled = !!data.enabled;
        this.store.setConfig("resources", rows);
        await this.changed();
        return this.publicList();
      }
      if (!["skill", "plugin", "mcp"].includes(data.kind || old?.kind))
        throw new Error("资源类型不支持");
      const row: Resource = old
        ? { ...old }
        : {
            id: randomUUID(),
            kind: data.kind,
            name: String(data.name || ""),
            source: String(data.source || ""),
            projectId: data.projectId || null,
            enabled: true,
          };
      if (
        row.projectId &&
        !this.store.projects().some((p) => p.id === row.projectId)
      )
        throw new Error("项目不存在");
      if (row.kind === "mcp") {
        if (!/^[A-Za-z0-9_-]+$/.test(data.name || row.name))
          throw new Error("MCP 名称使用字母、数字、下划线或连字符");
        row.name = data.name || row.name;
        row.config = data.config || row.config;
        const c = row.config as any;
        if (!c || (!c.command && !c.url))
          throw new Error("MCP 配置需要 command 或 url");
        if (c.url && !/^https?:\/\//.test(c.url))
          throw new Error("MCP 地址需要 HTTP(S)");
        row.source = c.command || c.url;
      } else {
        const resourceRoot = join(this.store.root, "resources", row.id);
        mkdirSync(resourceRoot, { recursive: true });
        const child = Bun.spawn(
          [
            process.execPath,
            resolve(
              import.meta.dir,
              "../../packages/runtime-omp/resource-operation.ts",
            ),
          ],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: join(resourceRoot, "agent"),
            },
          },
        );
        child.stdin.write(
          JSON.stringify({
            root: resourceRoot,
            kind: row.kind,
            source: row.source,
            name: row.name,
            action: data.action,
          }),
        );
        child.stdin.end();
        const timeout = setTimeout(() => child.kill(), 180000);
        try {
          const [output, error, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const line = output
            .split("\n")
            .findLast((l) => l.startsWith("BRO_RESOURCE_RESULT "));
          const response = line ? JSON.parse(line.slice(20)) : null;
          if (code !== 0 || response?.error || !response?.result)
            throw new Error(
              response?.error || error.slice(-2000) || "资源安装进程失败",
            );
          const result = response.result;
          row.path = result.path;
          row.name = result.name;
          row.version = result.version;
          if (row.kind === "plugin") row.plugin = result;
        } finally {
          clearTimeout(timeout);
        }
      }
      this.store.setConfig("resources", [
        ...rows.filter((r) => r.id !== row.id),
        row,
      ]);
      await this.changed();
      return this.publicList();
    };
    const pending = this.tail.then(action, action);
    this.tail = pending.catch(() => {});
    return pending;
  }
}
