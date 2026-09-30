import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import puppeteer from "puppeteer-core";

const root = mkdtempSync(join(tmpdir(), "bro-desktop-probe-"));
let requests = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const data = (await req.json()) as any;
    requests++;
    const messages = data.messages as any[],
      index = messages.findLastIndex((m) => m.role === "user");
    const text = JSON.stringify(messages[index]?.content);
    const hasTool = messages.slice(index).some((m) => m.role === "tool");
    if (text.includes("BRO_SLOW")) await Bun.sleep(3000);
    const naming = messages.some(
      (m) =>
        ["system", "developer"].includes(m.role) &&
        JSON.stringify(m.content).includes("<title>"),
    );
    const call = !naming && !hasTool && text.includes("BRO_GUI_WRITE");
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "gui-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: join(root, "workspaces", "界面 验证.txt"),
                  content: "GUI_WRITE_VERIFIED",
                }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: naming
            ? "<title>桌面验证会话</title>"
            : text.includes("BRO_SLOW")
              ? "BACKGROUND_COMPLETE"
              : "GUI_COMPLETE",
        };
    const frame = {
      id: "gui",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const port = process.env.BRO_PROBE_PORT || "9338";
let processHandle: any, browser: any;
const appBinary = process.env.BRO_APP_BINARY;
async function launch() {
  const args = appBinary
    ? [appBinary]
    : ["node", resolve("node_modules/electron/cli.js"), resolve(".")];
  processHandle = Bun.spawn(
    [
      ...args,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        BRO_DATA_DIR: root,
        ...(!appBinary
          ? { BRO_BUN_PATH: process.execPath }
          : {
              BRO_BUN_PATH: undefined,
              BRO_RENDERER_URL: undefined,
              PATH:
                process.platform === "win32"
                  ? `${process.env.SystemRoot}\System32;${process.env.SystemRoot}`
                  : "/usr/bin:/bin:/usr/sbin:/sbin",
            }),
      },
      cwd: appBinary ? dirname(appBinary) : resolve("."),
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  void new Response(processHandle.stderr)
    .text()
    .then((text) => writeFileSync(join(root, "electron.log"), text));
  for (let i = 0; i < 100; i++) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        defaultViewport: null,
      });
      break;
    } catch {
      await Bun.sleep(150);
    }
  }
  if (!browser) throw new Error("Electron did not open debugging endpoint");
  let page: any;
  for (let i = 0; i < 100; i++) {
    [page] = await browser.pages();
    if (page) break;
    await Bun.sleep(100);
  }
  await page
    .waitForFunction(
      () =>
        document
          .querySelector(".host-status")
          ?.textContent?.includes("后台已连接"),
      { timeout: 60000 },
    )
    .catch(async (error: any) => {
      writeFileSync(
        join(root, "startup-ui.txt"),
        await page.evaluate(() => document.body.innerText),
      );
      await page.screenshot({ path: join(root, "startup-failure.png") });
      throw error;
    });
  return page;
}
async function host(path: string, body?: any) {
  const info = JSON.parse(readFileSync(join(root, "host.json"), "utf8"));
  const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<any>;
}
try {
  let page = await launch();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.click(".connect-callout");
  async function fill(label: string, value: string) {
    const handle = await page.evaluateHandle(
      (label: string) =>
        Array.from(document.querySelectorAll("label.field"))
          .find((l) => l.textContent === label)
          ?.querySelector("input"),
      label,
    );
    const element = handle.asElement();
    if (!element) throw new Error(`No field ${label}`);
    await element.focus();
    await element.evaluate((el: any) => el.select());
    await element.type(value);
  }
  await fill("连接名称", "本地界面验证");
  await fill("Base URL", `http://127.0.0.1:${provider.port}/v1`);
  await fill("API Key", "fixture-only");
  await fill("模型 ID", "fixture");
  await page.click("form .primary");
  await page.waitForFunction(() =>
    document
      .querySelector(".connection-card")
      ?.textContent?.includes("本地界面验证"),
  );
  await page.click('[aria-label="关闭设置"]');
  await page.type('[aria-label="消息"]', "BRO_GUI_WRITE");
  await page.click('[aria-label="发送"]');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".message.assistant")).some((m) =>
        m.textContent?.includes("GUI_COMPLETE"),
      ),
    { timeout: 120000 },
  );
  if (
    readFileSync(join(root, "workspaces", "界面 验证.txt"), "utf8") !==
    "GUI_WRITE_VERIFIED"
  )
    throw new Error("GUI tool output missing");
  await page.waitForSelector("[data-message-id].assistant .markdown p");
  await page.waitForFunction(
    () => document.querySelector(".status-chip")?.textContent === "就绪",
  );
  await page.evaluate(() => {
    const node = document.querySelector(
      "[data-message-id].assistant .markdown p",
    )!;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.click(".annotation-button");
  await page.waitForSelector(".question-modal");
  await page.type(".question-modal textarea", "批注回归验证");
  await page.click(".question-modal .primary");
  await page.type('[aria-label="消息"]', "BRO_ANNOTATION");
  await page.click('[aria-label="发送"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".message.assistant").length >= 2,
    { timeout: 60000 },
  );
  const state = await host("/state"),
    session = state.sessions[0];
  const history = await host(`/sessions/${session.id}/history`);
  if (
    !history.inputs.some((i: any) =>
      i.annotations.some((a: any) => a.comment === "批注回归验证"),
    )
  )
    throw new Error("Annotation lost");
  await page.screenshot({ path: join(root, "desktop.png") });
  await page.type('[aria-label="消息"]', "BRO_SLOW");
  await page.click('[aria-label="发送"]');
  await page.waitForFunction(
    () => document.querySelector(".status-chip")?.textContent === "进行中",
  );
  await page.type('[aria-label="消息"]', "BRO_UNSENT_DRAFT");
  await browser.close();
  browser = undefined;
  await processHandle.exited;
  for (let i = 0; i < 150; i++) {
    const h = await host(`/sessions/${session.id}/history`);
    if (h.inputs.filter((x: any) => x.status === "completed").length === 3)
      break;
    await Bun.sleep(100);
  }
  if (!(await host("/health")).ok)
    throw new Error("Closing GUI killed the host");
  const after = await host(`/sessions/${session.id}/history`);
  if (!JSON.stringify(after.messages).includes("BACKGROUND_COMPLETE"))
    throw new Error("Background execution did not finish");
  page = await launch();
  await page.click(".session-item");
  await page.waitForFunction(() =>
    document.body.textContent?.includes("BACKGROUND_COMPLETE"),
  );
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-label="消息"]') as HTMLTextAreaElement)
        ?.value === "BRO_UNSENT_DRAFT",
  );
  await page.click(".nav-button");
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-label="消息"]') as HTMLTextAreaElement)
        ?.value === "",
  );
  await page.click(`[data-session-id="${session.id}"]`);
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-label="消息"]') as HTMLTextAreaElement)
        ?.value === "BRO_UNSENT_DRAFT",
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: true,
      root,
      requests,
      packaged: !!appBinary,
      proofs: [
        "GUI API configuration",
        "real OMP write",
        "text annotation submitted",
        "close GUI during running task",
        "host survives and finishes",
        "reopen shows retained history",
        "draft persists after restart and stays with its session",
      ],
    }),
  );
} catch (error) {
  console.error(error);
  console.error("Probe data:", root);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {}
  processHandle?.kill();
  try {
    const info = JSON.parse(readFileSync(join(root, "host.json"), "utf8"));
    process.kill(info.pid, "SIGTERM");
  } catch {}
  await provider.stop(true);
}
