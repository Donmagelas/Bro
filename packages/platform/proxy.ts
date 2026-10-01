import { shouldBypassProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const nativeFetch = globalThis.fetch;

async function directRequest(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  // The bare "undici" import is Bun's compatibility shim and shares its cached proxy.
  const { fetch: directFetch } = await import("undici/index.js");
  const request = new Request(input, init);
  return (await directFetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.body || undefined,
    duplex: "half",
    redirect: request.redirect,
    signal: request.signal,
  })) as unknown as Response;
}
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

// Remember only values Bro adopted, so a later network change can replace or
// remove them without overriding proxies explicitly supplied by the launcher.
export function systemProxyManager(
  env: NodeJS.ProcessEnv = process.env,
  read = async () =>
    (await exec("/usr/sbin/scutil", ["--proxy"], { timeout: 3000 })).stdout,
  platform: string = process.platform,
) {
  let adopted: Record<string, string> = {};
  let original: NodeJS.ProcessEnv = {};
  let pending: Promise<void> | undefined;
  let managed = false;
  const childEnvironment = () => {
    const base = { ...env };
    for (const [key, value] of Object.entries(adopted)) {
      if (base[key] !== value) continue;
      if (original[key] === undefined) delete base[key];
      else base[key] = original[key];
    }
    return base;
  };
  const refresh = (): Promise<void> => {
    if (platform !== "darwin") return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const base = childEnvironment();
      if (explicitProxyKeys.some((key) => base[key]?.trim())) {
        managed = false;
        return;
      }
      try {
        const next = macProxyEnvironment(await read(), base);
        for (const [key, value] of Object.entries(adopted)) {
          if (env[key] !== value) continue;
          if (original[key] === undefined) delete env[key];
          else env[key] = original[key];
        }
        managed = true;
        original = base;
        adopted = next;
        Object.assign(env, next);
      } catch {
        // Keep the last usable settings when querying the OS itself fails.
        console.warn("无法读取 macOS 系统代理；后台沿用现有网络环境");
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const request = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    fetchImpl: typeof fetch = fetch,
  ) => {
    await refresh();
    if (!managed || (init && "proxy" in init)) {
      if (
        init &&
        "proxy" in init &&
        init.proxy === "" &&
        fetchImpl === nativeFetch
      )
        return directRequest(input, init);
      return fetchImpl(input, init);
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    const proxy = shouldBypassProxy(url)
      ? ""
      : (url.protocol === "https:"
          ? adopted.HTTPS_PROXY
          : adopted.HTTP_PROXY) || "";
    // Bun caches an env proxy and even proxy: "" can reuse it after removal.
    // Use a direct HTTP dispatcher for that path; keep injected fetches intact.
    if (!proxy && fetchImpl === nativeFetch) return directRequest(input, init);
    return fetchImpl(input, { ...init, proxy });
  };
  return { refresh, childEnvironment, request };
}
const systemProxy = systemProxyManager();
export const inheritSystemProxy = systemProxy.refresh;
export const proxyEnvironmentForChild = systemProxy.childEnvironment;

export const fetchWithSystemProxy = systemProxy.request;
let fetchInstalled = false;
export function installSystemProxyFetch() {
  if (fetchInstalled || process.platform !== "darwin") return;
  fetchInstalled = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      systemProxy.request(input, init, originalFetch),
    originalFetch,
  );
}
