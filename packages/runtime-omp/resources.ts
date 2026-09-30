import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Resource, Session } from "../contracts";

// OMP's directory convenience loader only scans children. Explicit bro
// resources also allow selecting a single directory containing SKILL.md.
export async function loadBroSkills(dir: string, source: string) {
  const module = resolve(
    import.meta.dir,
    "../../node_modules/@oh-my-pi/pi-coding-agent/src/discovery/helpers.ts",
  );
  const { scanSkillsFromDir } = await import(module);
  const result = await scanSkillsFromDir(
    { cwd: process.cwd(), home: homedir(), repoRoot: null },
    {
      dir,
      providerId: "bro",
      level: source === "bro:project" ? "project" : "user",
      requireDescription: true,
      includeSelf: true,
    },
  );
  return {
    skills: result.items.map((skill: any) => ({
      name: skill.name,
      description: skill.frontmatter.description,
      filePath: skill.path,
      baseDir: dirname(skill.path),
      source,
      hide:
        skill.frontmatter.hide === true ||
        skill.frontmatter.disableModelInvocation === true,
      _source: skill._source,
    })),
    warnings: (result.warnings || []).map((message: string) => ({ message })),
  };
}

export async function loadResources(
  root: string,
  session: Session,
  resources: Resource[],
) {
  const base = resolve(
    import.meta.dir,
    "../../node_modules/@oh-my-pi/pi-coding-agent/src",
  );
  const {
    resolvePluginExtensionPaths,
    resolvePluginToolPaths,
    resolvePluginHookPaths,
  } = await import(join(base, "extensibility/plugins/loader.ts"));
  const { MCPManager } = await import(join(base, "mcp/manager.ts"));
  const selected = resources.filter(
    (r) => r.enabled && (!r.projectId || r.projectId === session.projectId),
  );
  const skills = new Map<string, any>(),
    warnings: string[] = [];
  const directories = [
    join(root, "agent", "skills"),
    ...selected.filter((r) => r.kind === "skill").map((r) => r.path!),
    join(session.cwd, ".bro", "skills"),
  ];
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    const found = await loadBroSkills(
      dir,
      dir.startsWith(session.cwd) ? "bro:project" : "bro:user",
    );
    for (const s of found.skills) skills.set(s.name, s);
    warnings.push(...found.warnings.map((w: any) => w.message));
  }
  const contextFiles = [];
  // Only explicit bro rules and the current project's AGENTS.md are inherited.
  for (const path of [
    join(root, "agent", "AGENTS.md"),
    join(session.cwd, "AGENTS.md"),
  ])
    if (existsSync(path))
      contextFiles.push({ path, content: readFileSync(path, "utf8") });
  const plugins = selected
    .filter((r) => r.kind === "plugin")
    .map((r) => ({ ...r.plugin, enabled: true }));
  const extensionPaths = plugins.flatMap((p) => [
    ...resolvePluginExtensionPaths(p),
    ...resolvePluginHookPaths(p),
  ]);
  const customToolPaths = plugins.flatMap((p) =>
    resolvePluginToolPaths(p).map((path: string) => ({
      path,
      source: { provider: "bro", providerName: "Bro", level: "user" },
    })),
  );
  const configs = Object.fromEntries(
    selected
      .filter((r) => r.kind === "mcp")
      .map((r) => [r.name, { ...r.config, enabled: true }]),
  );
  const mcpManager = new MCPManager(session.cwd, null, async () => ({
    configs,
    exaApiKeys: [],
    sources: {},
  }));
  await mcpManager.discoverAndConnect();
  return {
    skills: [...skills.values()],
    contextFiles,
    preloadedExtensionPaths: extensionPaths,
    preloadedCustomToolPaths: customToolPaths,
    mcpManager,
    warnings,
  };
}
