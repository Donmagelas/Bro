import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const explicitProxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "PI_PROXY",
];

/** Translate macOS's manual HTTP proxy settings for the Bun host and its workers. */
export function macProxyEnvironment(
  output: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (explicitProxyKeys.some((key) => env[key]?.trim())) return {};
  const values = Object.fromEntries(
    [...output.matchAll(/^\s*(\w+) : (.+)$/gm)].map((m) => [m[1], m[2].trim()]),
  );
  // A PAC/WPAD decision depends on the target URL and cannot become a global env proxy.
  if (
    values.ProxyAutoConfigEnable === "1" ||
    values.ProxyAutoDiscoveryEnable === "1"
  )
    return {};
  const result: Record<string, string> = {};
  for (const scheme of ["HTTP", "HTTPS"]) {
    if (values[`${scheme}Enable`] !== "1") continue;
    const host = values[`${scheme}Proxy`];
    const port = Number(values[`${scheme}Port`]);
    if (
      !host ||
      !/^[\w.:[\]-]+$/.test(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      continue;
    const authority =
      host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    // HTTPSProxy denotes an HTTP CONNECT proxy for HTTPS destinations.
    result[`${scheme}_PROXY`] = `http://${authority}:${port}`;
  }
  if (Object.keys(result).length) {
    const exceptions =
      output.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1] ?? "";
    const bypass = [...exceptions.matchAll(/\d+\s*:\s*(\S+)/g)].map((m) =>
      m[1].startsWith("*.") ? m[1].slice(1) : m[1],
    );
    const noProxy = [
      env.NO_PROXY || env.no_proxy,
      "localhost",
      "127.0.0.1",
      "::1",
      ...bypass,
    ]
      .filter(Boolean)
      .join(",");
    result.NO_PROXY = result.no_proxy = noProxy;
  }
  return result;
}

export async function inheritSystemProxy(): Promise<void> {
  if (
    process.platform !== "darwin" ||
    explicitProxyKeys.some((key) => process.env[key]?.trim())
  )
    return;
  try {
    const { stdout } = await exec("/usr/sbin/scutil", ["--proxy"], {
      timeout: 3000,
    });
    const env = macProxyEnvironment(stdout, process.env);
    Object.assign(process.env, env);
    if (env.HTTP_PROXY || env.HTTPS_PROXY)
      console.log("bro 后台已继承 macOS 手动 HTTP/HTTPS 代理");
  } catch {
    console.warn("无法读取 macOS 系统代理；后台沿用现有网络环境");
  }
}
