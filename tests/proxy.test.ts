import { expect, test } from "bun:test";
import { macProxyEnvironment } from "../packages/platform/proxy";

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
      import { macProxyEnvironment } from ${JSON.stringify(new URL("../packages/platform/proxy.ts", import.meta.url).href)};
      Object.assign(process.env, macProxyEnvironment(${JSON.stringify(input)}, {}));
      const proxied = await fetch("http://bro-proxy-probe.invalid", { signal: AbortSignal.timeout(3000) });
      const local = await fetch("http://127.0.0.1:${local.port}", { signal: AbortSignal.timeout(3000) });
      console.log(JSON.stringify([await proxied.text(), await local.text()]));
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
    expect(JSON.parse(stdout.trim())).toEqual(["proxy", "direct"]);
  } finally {
    await proxy.stop(true);
    await local.stop(true);
  }
});
