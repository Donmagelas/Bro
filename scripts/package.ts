import {
  cpSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  platform = process.platform,
  arch = process.arch;
if (!["darwin", "win32"].includes(platform))
  throw new Error("请在 macOS 或 Windows 上打包对应平台");
const label = `${platform === "darwin" ? "macos" : "windows"}-${arch}`,
  destination = join(root, "out", label);
mkdirSync(destination, { recursive: true });
const electron = join(root, "node_modules", "electron", "dist");
const bundle = join(destination, platform === "darwin" ? "Bro.app" : "Bro");
// Only delete this script's previous generated bundle, never application data.
rmSync(bundle, { recursive: true, force: true });
cpSync(
  platform === "darwin" ? join(electron, "Electron.app") : electron,
  bundle,
  { recursive: true, verbatimSymlinks: true },
);
const resources =
  platform === "darwin"
    ? join(bundle, "Contents", "Resources")
    : join(bundle, "resources");
const app = join(resources, "app");
mkdirSync(app, { recursive: true });
for (const item of ["apps", "packages", "dist", "package.json", "bun.lock"])
  cpSync(join(root, item), join(app, item), {
    recursive: true,
    verbatimSymlinks: true,
  });
const runtime = join(resources, "runtime");
mkdirSync(runtime, { recursive: true });
const binary = join(runtime, platform === "win32" ? "bun.exe" : "bun");
cpSync(process.execPath, binary);
if (platform !== "win32") chmodSync(binary, 0o755);
const run = async (command: string[], cwd = root) => {
  console.log(`Packaging: ${command[0]} ${command.slice(1, 3).join(" ")}`);
  const child = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if ((await child.exited) !== 0)
    throw new Error(`打包命令失败：${command[0]}`);
};
await run(
  [
    process.execPath,
    "install",
    "--production",
    "--frozen-lockfile",
    "--prefer-offline",
    ...(process.env.BRO_NPM_REGISTRY
      ? ["--registry", process.env.BRO_NPM_REGISTRY]
      : []),
  ],
  app,
);
cpSync(join(root, "packaging/licenses"), join(resources, "licenses"), {
  recursive: true,
});
cpSync(
  join(root, "node_modules/electron/dist/LICENSE"),
  join(resources, "licenses/Electron-LICENSE.txt"),
);
writeFileSync(
  join(resources, "BRO-NOTICE.txt"),
  "Bro bundles Electron, Bun, and OMP 18.4.3. Their licenses are included alongside the binaries and packages. This local build is not notarized or signed with a distribution certificate.\n",
);
if (platform === "darwin") {
  renameSync(
    join(bundle, "Contents", "MacOS", "Electron"),
    join(bundle, "Contents", "MacOS", "Bro"),
  );
  await run([
    "xcrun",
    "swiftc",
    join(app, "packages/platform/input-monitor.swift"),
    "-o",
    join(app, "packages/platform/input-monitor-macos"),
  ]);
  cpSync(
    join(root, "apps/desktop/assets/icon.icns"),
    join(resources, "Bro.icns"),
  );
  const plist = join(bundle, "Contents", "Info.plist");
  for (const [key, value] of [
    ["CFBundleExecutable", "Bro"],
    ["CFBundleDisplayName", "Bro"],
    ["CFBundleName", "Bro"],
    ["CFBundleIdentifier", "io.donmagelas.bro"],
    ["CFBundleIconFile", "Bro.icns"],
    ["CFBundleShortVersionString", "0.1.0"],
    ["CFBundleVersion", "1"],
  ])
    await run(["/usr/libexec/PlistBuddy", "-c", `Set :${key} ${value}`, plist]);
  await run([
    "codesign",
    "--force",
    "--deep",
    "--sign",
    "-",
    "--entitlements",
    join(root, "packaging", "entitlements.mac.plist"),
    bundle,
  ]);
  rmSync(join(destination, "Bro-macos.zip"), { force: true });
  await run([
    "ditto",
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    bundle,
    join(destination, "Bro-macos.zip"),
  ]);
} else {
  // Embed the icon and product name in the executable, including Explorer's
  // file properties. A BrowserWindow icon alone leaves Electron's EXE icon.
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import(
    "resedit"
  );
  const exe = NtExecutable.from(readFileSync(join(bundle, "electron.exe")), {
    ignoreCert: true,
  });
  const res = NtExecutableResource.from(exe);
  const icons = Data.IconFile.from(
    readFileSync(join(root, "apps/desktop/assets/icon.ico")),
  ).icons.map((item) => item.data);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }])
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      group.id,
      group.lang,
      icons,
    );
  for (const version of Resource.VersionInfo.fromEntries(res.entries)) {
    for (const language of version.getAllLanguagesForStringValues())
      version.setStringValues(language, {
        ProductName: "Bro",
        FileDescription: "Bro",
        InternalName: "Bro",
        OriginalFilename: "Bro.exe",
      });
    version.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  writeFileSync(join(bundle, "Bro.exe"), Buffer.from(exe.generate()));
  rmSync(join(bundle, "electron.exe"));
  const archive = join(destination, "Bro-windows.zip");
  rmSync(archive, { force: true });
  // Pass paths through environment variables, not interpolated PowerShell code.
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Compress-Archive -Path $env:BRO_PACKAGE_SOURCE -DestinationPath $env:BRO_PACKAGE_ARCHIVE",
    ],
    {
      env: {
        ...process.env,
        BRO_PACKAGE_SOURCE: bundle,
        BRO_PACKAGE_ARCHIVE: archive,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0) throw new Error("Windows 压缩失败");
}
console.log(`Package ready: ${bundle}`);
