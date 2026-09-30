import { join } from "node:path";
import type { Store } from "./store";
import type {
  Connection,
  ModelChoice,
  Thinking,
  ChatGPTQuota,
} from "../../packages/contracts";

export class AccountAuth {
  private storage: any;
  private registry: any;
  private initializing?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private login?: Promise<void>;
  private quotaCache?: ChatGPTQuota;
  private quotaRequest?: Promise<ChatGPTQuota>;
  private quotaController?: AbortController;
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
  quota(force = false): Promise<ChatGPTQuota> {
    if (this.closing) return Promise.reject(new Error("认证服务已关闭"));
    if (this.quotaRequest) return this.quotaRequest;
    if (
      !force &&
      this.quotaCache &&
      Date.now() - this.quotaCache.checkedAt < 60000
    )
      return Promise.resolve(this.quotaCache);
    const controller = new AbortController();
    this.quotaController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(12000),
    ]);
    const request = this.use(async (): Promise<ChatGPTQuota> => {
      await this.storage.credentials.reload();
      const accounts = await this.storage.oauth.accessAll("openai-codex", {
        signal,
      });
      if (!accounts.length)
        return { status: "signed_out", checkedAt: Date.now(), accounts: [] };
      const provider = this.storage.usage.providerFor("openai-codex");
      const results = await Promise.all(
        accounts.map(async (account: any, index: number) => {
          const report =
            account.ok && provider
              ? await provider
                  .fetchUsage(
                    {
                      provider: "openai-codex",
                      credential: {
                        type: "oauth",
                        accessToken: account.accessToken,
                        accountId: account.accountId,
                      },
                      signal,
                    },
                    { fetch },
                  )
                  .catch(() => null)
              : null;
          const credits = report?.raw?.credits;
          const balance =
            credits?.balance !== undefined &&
            credits.balance !== null &&
            credits.balance !== ""
              ? Number(credits.balance)
              : NaN;
          return {
            id: String(account.credentialId ?? index),
            email: account.email,
            updatedAt: report?.fetchedAt,
            windows: (report?.limits || []).map((limit: any) => {
              const duration = limit.window?.durationMs;
              const base = [
                "openai-codex:primary",
                "openai-codex:secondary",
              ].includes(limit.id);
              const label =
                duration === 604800000
                  ? "每周"
                  : duration && duration % 3600000 === 0
                    ? `${duration / 3600000} 小时`
                    : limit.window?.label || "当前周期";
              const remaining =
                limit.amount?.remainingFraction !== undefined
                  ? limit.amount.remainingFraction * 100
                  : limit.amount?.usedFraction !== undefined
                    ? (1 - limit.amount.usedFraction) * 100
                    : NaN;
              return {
                id: limit.id,
                label: base ? label : limit.label,
                remainingPercent: Number.isFinite(remaining)
                  ? Math.max(0, Math.min(100, remaining))
                  : null,
                resetsAt: Number.isFinite(limit.window?.resetsAt)
                  ? limit.window.resetsAt
                  : null,
              };
            }),
            ...(credits
              ? {
                  credits: {
                    unlimited: credits.unlimited === true,
                    balance: Number.isFinite(balance) ? balance : null,
                  },
                }
              : {}),
          };
        }),
      );
      return {
        status: results.some((a) => a.updatedAt !== undefined)
          ? "ready"
          : "unavailable",
        checkedAt: Date.now(),
        accounts: results,
      };
    })
      .catch(
        (): ChatGPTQuota => ({
          status: "unavailable",
          checkedAt: Date.now(),
          accounts: [],
        }),
      )
      .then((result) => {
        if (controller.signal.aborted)
          return {
            status: "unavailable",
            checkedAt: Date.now(),
            accounts: [],
          } as ChatGPTQuota;
        this.quotaCache = result;
        return result;
      })
      .finally(() => {
        if (this.quotaRequest === request) this.quotaRequest = undefined;
      });
    this.quotaRequest = request;
    return request;
  }
  private clearQuota() {
    this.quotaController?.abort();
    this.quotaRequest = undefined;
    this.quotaCache = undefined;
  }
  start() {
    return this.use(async () => {
      if (this.controller) throw new Error("登录正在进行");
      this.clearQuota();
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
          this.clearQuota();
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
      this.clearQuota();
      this.changed();
    });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.cancel();
      this.clearQuota();
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
