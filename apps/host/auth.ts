import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";

export class AccountAuth {
  private storage: any;
  private registry: any;
  private initializing?: Promise<void>;
  private controller?: AbortController;
  private answer?: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  };
  private loginState: {
    status: string;
    url?: string;
    instructions?: string;
    prompt?: string;
    error?: string;
  } = { status: "idle" };
  constructor(
    private store: Store,
    private changed: () => void,
  ) {}
  private init() {
    return (this.initializing ??= Promise.resolve()
      .then(async () => {
        const name = "@oh-my-pi/pi-coding-agent",
          omp = await import(name);
        const agentDir = join(this.store.root, "agent");
        this.storage = await omp.discoverAuthStorage(agentDir);
        this.registry = new omp.ModelRegistry(
          this.storage,
          join(agentDir, "models.yml"),
        );
        await this.registry.refresh("offline");
      })
      .catch((error) => {
        this.initializing = undefined;
        throw error;
      }));
  }
  async status() {
    await this.init();
    await this.storage.credentials.reload();
    return {
      ...this.loginState,
      accounts: this.storage.oauth
        .accounts("openai-codex")
        .map((a: any) => ({ email: a.email, accountId: a.accountId })),
      models: this.registry
        .getAll()
        .filter((m: any) => m.provider === "openai-codex")
        .map((m: any) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
          imageInput: m.input?.includes("image"),
        })),
    };
  }
  async start() {
    await this.init();
    if (this.controller) throw new Error("登录正在进行");
    this.controller = new AbortController();
    this.loginState = { status: "starting" };
    this.changed();
    void this.storage.oauth
      .login("openai-codex", {
        signal: this.controller.signal,
        onAuth: (info: any) => {
          this.loginState = {
            status: "waiting",
            url: info.url,
            instructions: info.instructions,
          };
          this.changed();
        },
        onProgress: (message: string) => {
          this.loginState.instructions = message;
          this.changed();
        },
        onPrompt: (prompt: any) =>
          new Promise<string>((resolve, reject) => {
            this.answer = { resolve, reject };
            this.loginState.prompt = prompt.message;
            this.changed();
          }),
      })
      .then((identity: any) => {
        if (!identity) throw new Error("登录未保存账号");
        this.loginState = { status: "success" };
        this.changed();
      })
      .catch((e: unknown) => {
        const error = String(e);
        this.loginState = {
          status: "error",
          error: error.includes("unsupported_country_region_territory")
            ? "ChatGPT 登录未完成：OpenAI 拒绝了后台请求的网络地区（403）。请检查系统代理和网络出口，调整后停止并重启 Bro 后台，再重新登录。"
            : error,
        };
        this.changed();
      })
      .finally(() => {
        this.controller = undefined;
        this.answer = undefined;
      });
    return { started: true };
  }
  submit(value: string) {
    if (!this.answer) throw new Error("当前没有待输入的登录信息");
    this.answer.resolve(value);
    this.answer = undefined;
    delete this.loginState.prompt;
    this.changed();
  }
  cancel() {
    this.controller?.abort();
    this.answer?.reject(new Error("登录已取消"));
    this.answer = undefined;
    this.loginState = { status: "idle" };
    this.changed();
  }
  async logout() {
    await this.init();
    this.cancel();
    await this.storage.credentials.remove("openai-codex");
    this.changed();
  }
}
