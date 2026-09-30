import { join } from "node:path";
import type { Store } from "./store";
import type {
  Connection,
  ModelChoice,
  Thinking,
} from "../../packages/contracts";

export class AccountAuth {
  private storage: any;
  private registry: any;
  private initializing?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private login?: Promise<void>;
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
        this.storage?.close();
        this.storage = undefined;
        this.registry = undefined;
        this.initializing = undefined;
        throw error;
      }));
  }
  private use<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("认证服务已关闭"));
    const operation = this.init().then(() => {
      if (this.closing) throw new Error("认证服务已关闭");
      return action();
    });
    this.pending.add(operation);
    return operation.finally(() => this.pending.delete(operation));
  }
  status() {
    return this.use(async () => {
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
            thinkingLevels: (m.reasoning ? m.thinking?.efforts : null) || [],
            defaultThinking: m.thinking?.defaultLevel,
          })),
      };
    });
  }
  async models(connection: Connection): Promise<ModelChoice[]> {
    if (connection.kind === "api")
      return [
        {
          connectionId: connection.id,
          id: connection.model,
          name: connection.model,
          thinkingLevels: connection.reasoning
            ? ["off", "minimal", "low", "medium", "high", "xhigh"]
            : [],
          defaultThinking: connection.reasoning ? "medium" : "off",
        },
      ];
    const { models } = await this.status();
    return models.map((model: any) => {
      const thinkingLevels = model.thinkingLevels as Thinking[];
      return {
        connectionId: connection.id,
        id: model.id,
        name: model.name || model.id,
        thinkingLevels,
        defaultThinking:
          model.defaultThinking ||
          (thinkingLevels.includes("medium") ? "medium" : thinkingLevels[0]) ||
          "off",
      };
    });
  }
  start() {
    return this.use(async () => {
      if (this.controller) throw new Error("登录正在进行");
      this.controller = new AbortController();
      this.loginState = { status: "starting" };
      this.changed();
      this.login = this.storage.oauth
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
    });
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
  logout() {
    return this.use(async () => {
      this.cancel();
      await this.login;
      await this.storage.credentials.remove("openai-codex");
      this.changed();
    });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.cancel();
      // Initialization/credential reads may still own the database. Login also
      // needs to finish cancelling before its store can be closed safely.
      await Promise.allSettled([...this.pending]);
      await this.login;
      this.storage?.close();
      this.storage = undefined;
      this.registry = undefined;
    })());
  }
}
