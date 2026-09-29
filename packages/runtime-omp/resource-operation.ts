import { join, isAbsolute, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// PluginManager uses process-wide OMP paths. Keep every resource operation in
// its own process and set the scope before importing OMP.
const request = (await Bun.stdin.json()) as any;
process.env.PI_CODING_AGENT_DIR = join(request.root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const moduleName = "@oh-my-pi/pi-coding-agent";
const base = resolve(
  import.meta.dir,
  "../../node_modules/@oh-my-pi/pi-coding-agent/src",
);
try {
  let result: any;
  if (request.kind === "plugin") {
    const module = join(base, "extensibility/plugins/manager.ts");
    const { PluginManager } = await import(module);
    const manager = new PluginManager(request.root);
    if (request.action === "remove") {
      await manager.uninstall(request.name);
      result = {};
    } else {
      const before = (await manager.list()).find(
        (p: any) => p.name === request.name,
      );
      const source = request.source;
      result = isAbsolute(source)
        ? await manager.link(source)
        : await manager.install(source);
      if (before && !before.enabled)
        await manager.setEnabled(result.name, false);
    }
  } else {
    let path = request.source;
    if (!isAbsolute(path)) {
      const target = join(request.root, "checkout");
      const run = async (args: string[]) => {
        const child = Bun.spawn(["git", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(child.stderr).text();
        if ((await child.exited) !== 0) throw new Error(output);
      };
      if (!/^https:\/\/|^ssh:\/\/|^git@/.test(path))
        throw new Error("Skill 来源需要本机绝对路径或 Git 地址");
      if (existsSync(target)) {
        await run(["-C", target, "pull", "--ff-only"]);
      } else await run(["clone", "--depth", "1", "--", path, target]);
      path = target;
    }
    if (!existsSync(path)) throw new Error("Skill 路径不存在");
    const skillModule = join(base, "extensibility/skills.ts");
    const { loadSkillsFromDir } = await import(skillModule);
    const loaded = await loadSkillsFromDir({ dir: path, source: "bro:user" });
    if (!loaded.skills.length)
      throw new Error(
        "此目录没有有效的 SKILL.md：" +
          loaded.warnings.map((w: any) => w.message).join("; "),
      );
    result = {
      path,
      name: loaded.skills.map((s: any) => s.name).join(", "),
      version: "local",
      warnings: loaded.warnings,
    };
    if (existsSync(join(path, ".git"))) {
      const child = Bun.spawn(
        ["git", "-C", path, "rev-parse", "--short", "HEAD"],
        { stdout: "pipe" },
      );
      result.version = (await new Response(child.stdout).text()).trim();
      await child.exited;
    }
  }
  console.log("BRO_RESOURCE_RESULT " + JSON.stringify({ result }));
} catch (error) {
  console.log(
    "BRO_RESOURCE_RESULT " + JSON.stringify({ error: String(error) }),
  );
  process.exitCode = 1;
}
