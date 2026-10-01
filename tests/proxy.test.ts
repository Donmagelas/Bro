import { expect, test } from "bun:test";
import {
  macProxyEnvironment,
  systemProxyManager,
} from "../packages/platform/proxy";

const settings = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : intranet.example
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
}`;

test("manual system proxies preserve per-scheme routing and loopback/existing bypasses", () => {
  const env = macProxyEnvironment(settings, { no_proxy: "custom.example" });
  expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
  expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7891");
  expect(env.NO_PROXY).toBe(
    "custom.example,localhost,127.0.0.1,::1,.local,intranet.example",
  );
  expect(env.no_proxy).toBe(env.NO_PROXY);
});

test("explicit environment proxies win and PAC/WPAD are not guessed", () => {
  for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "PI_PROXY"])
    expect(
      macProxyEnvironment(settings, { [key]: "http://explicit:8080" }),
    ).toEqual({});
  expect(
    macProxyEnvironment(
      settings.replace(
        "ProxyAutoConfigEnable : 0",
        "ProxyAutoConfigEnable : 1",
      ),
      {},
    ),
  ).toEqual({});
  expect(
    macProxyEnvironment(settings + "\nProxyAutoDiscoveryEnable : 1", {}),
  ).toEqual({});
  expect(macProxyEnvironment("<dictionary> {}", {})).toEqual({});
});

test("disabled and invalid proxies are ignored; IPv6 proxy hosts are bracketed", () => {
  expect(
    macProxyEnvironment(settings.replaceAll("Enable : 1", "Enable : 0"), {}),
  ).toEqual({});
  const env = macProxyEnvironment(
    settings
      .replace("HTTPPort : 7890", "HTTPPort : 99999")
      .replace("HTTPSProxy : 127.0.0.1", "HTTPSProxy : ::1"),
    {},
  );
  expect(env.HTTP_PROXY).toBeUndefined();
  expect(env.HTTPS_PROXY).toBe("http://[::1]:7891");
});

test("Bun requests use the inherited proxy while local host traffic stays direct", async () => {
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("proxy"),
  });
  const replacement = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("new proxy"),
  });
  const local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("direct"),
  });
  try {
    const input = settings.replace(
      "HTTPPort : 7890",
      `HTTPPort : ${proxy.port}`,
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { systemProxyManager } from ${JSON.stringify(new URL("../packages/platform/proxy.ts", import.meta.url).href)};
      let output = ${JSON.stringify(input)};
      const manager = systemProxyManager(process.env, async () => output, "darwin");
      await manager.refresh();
      const proxied = await manager.request("http://bro-proxy-probe.invalid", { signal: AbortSignal.timeout(3000) });
      const local = await manager.request("http://127.0.0.1:${local.port}", { signal: AbortSignal.timeout(3000) });
      output = output.replace("HTTPPort : ${proxy.port}", "HTTPPort : ${replacement.port}");
      await manager.refresh();
      const changed = await manager.request("http://bro-proxy-probe.invalid", { signal: AbortSignal.timeout(3000) });
      output = "<dictionary> {}";
      await manager.refresh();
      const directFailure = await manager.request("http://bro-proxy-probe.invalid", { signal: AbortSignal.timeout(3000) }).then(() => false, () => true);
      console.log(JSON.stringify([await proxied.text(), await local.text(), await changed.text(), process.env.HTTP_PROXY === undefined, directFailure]));
    `,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/(^|_)proxy($|_)/i.test(key),
          ),
        ),
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual([
      "proxy",
      "direct",
      "new proxy",
      true,
      true,
    ]);
  } finally {
    await proxy.stop(true);
    await replacement.stop(true);
    await local.stop(true);
  }
});

test("system proxy changes replace and remove only Bro-adopted values; workers rediscover them", async () => {
  let output = settings;
  const env: NodeJS.ProcessEnv = { NO_PROXY: "keep.example" };
  const manager = systemProxyManager(env, async () => output, "darwin");
  await manager.refresh();
  expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
  expect(manager.childEnvironment()).toEqual({ NO_PROXY: "keep.example" });
  output = settings
    .replaceAll("127.0.0.1", "localhost")
    .replace("7890", "8000");
  await manager.refresh();
  expect(env.HTTP_PROXY).toBe("http://localhost:8000");
  output = "<dictionary> {}";
  await manager.refresh();
  expect(env).toEqual({ NO_PROXY: "keep.example" });
  output = settings;
  env.HTTPS_PROXY = "http://explicit:8080";
  await manager.refresh();
  expect(env).toEqual({
    NO_PROXY: "keep.example",
    HTTPS_PROXY: "http://explicit:8080",
  });
});
