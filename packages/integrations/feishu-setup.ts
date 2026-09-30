// Registration protocol adapted from larksuite/cli v1.0.95 (MIT).
// See packaging/licenses/Lark-CLI-LICENSE.txt and solution.md for provenance.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import qrcode from "qrcode-generator";
import type { Store } from "../../apps/host/store";
import type { FeishuSetupState } from "../contracts";
import type { Feishu, FeishuConfig } from "./feishu";

const registrationURL = "https://accounts.feishu.cn/oauth/v1/app/registration";
const apiRoot = "https://open.feishu.cn/open-apis";
const key = "feishuSetup";
type RecordState = FeishuSetupState & {
  deviceCode?: string;
  interval?: number;
  appSecret?: string;
};
const bounded = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback;
const string = (value: unknown) => (typeof value === "string" ? value : "");
const ownerId = (value: unknown) => /^ou_[\w-]+$/.test(string(value));

export class FeishuSetup {
  private record: RecordState;
  private controller?: AbortController;
  private work?: Promise<void>;
  private closed = false;
  constructor(
    private store: Store,
    private feishu: Feishu,
    private changed: () => void,
    private request: typeof fetch = fetch,
    private wait: (ms: number, signal: AbortSignal) => Promise<unknown> = (
      ms,
      signal,
    ) => delay(ms, undefined, { signal }),
  ) {
    this.record = store.getConfig<RecordState>(key, { status: "idle" });
  }
  state(): FeishuSetupState {
    const {
      status,
      verificationUrl,
      qrCode,
      expiresAt,
      appId,
      ownerOpenId,
      pairingCode,
      pairingExpiresAt,
      error,
    } = this.record;
    return {
      status,
      verificationUrl,
      qrCode,
      expiresAt,
      appId,
      ownerOpenId,
      pairingCode,
      pairingExpiresAt,
      error,
    };
  }
  private save(record: RecordState) {
    this.record = record;
    this.store.setConfig(key, record);
    this.changed();
  }
  private launch(action: (signal: AbortSignal) => Promise<void>) {
    if (this.closed) throw new Error("飞书配置服务已关闭");
    if (this.work) return this.state();
    const controller = new AbortController();
    this.controller = controller;
    this.work = Promise.resolve()
      .then(() => action(controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted)
          this.save({
            ...this.record,
            status: "error",
            error:
              error instanceof SetupError
                ? error.message
                : "连接飞书失败，请检查网络后重试。",
          });
      })
      .finally(() => {
        this.work = undefined;
        this.controller = undefined;
        if (!this.closed) this.changed();
      });
    return this.state();
  }
  private async read(url: string, init: RequestInit, signal: AbortSignal) {
    const r = await this.request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    // Only fixed messages/codes leave the backend; platform bodies may contain credentials.
    let data: any;
    try {
      data = await r.json();
    } catch {
      throw new SetupError("飞书返回了无效响应，请重试。");
    }
    if (!r.ok && !data?.error)
      throw new SetupError(`飞书服务暂不可用（HTTP ${r.status}）。`);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new SetupError("飞书返回了无效响应，请重试。");
    signal.throwIfAborted();
    return data;
  }
  private register(body: Record<string, string>, signal: AbortSignal) {
    return this.read(
      registrationURL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      },
      signal,
    );
  }
  start(replace = false) {
    if (this.closed) throw new Error("飞书配置服务已关闭");
    if (this.work) return this.state();
    if (this.record.appSecret || this.record.deviceCode) return this.retry();
    if (this.store.getConfig("feishu", null) && !replace)
      throw new Error("已有飞书连接，请明确选择创建新应用并替换。");
    this.save({ status: "starting" });
    return this.launch(async (signal) => {
      const data = await this.register(
        {
          action: "begin",
          archetype: "PersonalAgent",
          auth_method: "client_secret",
          request_user_info: "open_id tenant_brand",
        },
        signal,
      );
      if (data.error || !string(data.device_code) || !string(data.user_code))
        throw new SetupError("无法开始扫码创建，请稍后重试。");
      const verificationUrl = `https://open.feishu.cn/page/cli?user_code=${encodeURIComponent(data.user_code)}`;
      const qr = qrcode(0, "M");
      qr.addData(verificationUrl);
      qr.make();
      const qrCode = qr.createDataURL(6, 24);
      signal.throwIfAborted();
      this.save({
        status: "waiting",
        verificationUrl,
        qrCode,
        deviceCode: data.device_code,
        expiresAt:
          Date.now() +
          bounded(data.expire_in ?? data.expires_in, 600, 3600) * 1000,
        interval: bounded(data.interval, 5, 60) * 1000,
      });
      await this.poll(signal);
    });
  }
  resume() {
    if (this.record.deviceCode) return this.retry();
    if (this.record.appSecret || this.record.status === "starting")
      this.save({
        ...this.record,
        status: "error",
        error: this.record.appSecret
          ? "应用已创建，点击继续连接。"
          : "创建流程已中断，请重试。",
      });
  }
  retry() {
    if (this.work) return this.state();
    return this.launch(async (signal) => {
      if (this.record.appSecret) await this.connect(signal);
      else if (this.record.deviceCode) {
        this.save({ ...this.record, status: "waiting", error: undefined });
        await this.poll(signal);
      } else if (
        this.record.appId &&
        this.store.getConfig<FeishuConfig | null>("feishu", null)?.appId ===
          this.record.appId
      ) {
        await this.feishu.start();
      } else throw new SetupError("请重新发起扫码创建。");
    });
  }
  private async poll(signal: AbortSignal) {
    const deadline = this.record.expiresAt!;
    const pollingSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    let interval = this.record.interval || 5000;
    while (Date.now() < deadline) {
      let data: any;
      try {
        data = await this.register(
          { action: "poll", device_code: this.record.deviceCode! },
          pollingSignal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (Date.now() >= deadline) break;
        await this.wait(Math.min(interval, deadline - Date.now()), signal);
        continue;
      }
      // This product currently supports Feishu; never send a device code to an arbitrary domain.
      if (
        data.user_info?.tenant_brand &&
        data.user_info.tenant_brand !== "feishu"
      )
        throw new SetupError(
          "请使用飞书账号创建应用，目前暂不支持 Lark 国际版。",
        );
      if (!data.error && string(data.client_id) && string(data.client_secret)) {
        this.save({
          status: "connecting",
          appId: data.client_id,
          appSecret: data.client_secret,
          ownerOpenId: ownerId(data.user_info?.open_id)
            ? data.user_info.open_id
            : undefined,
        });
        await this.connect(signal);
        return;
      }
      if (data.error === "access_denied") {
        this.save({ status: "cancelled", error: "你已取消飞书授权。" });
        return;
      }
      if (["expired_token", "invalid_grant"].includes(data.error)) break;
      if (
        data.error &&
        !["authorization_pending", "slow_down"].includes(data.error)
      )
        throw new SetupError(
          "飞书未完成应用创建，请在官方页面查看原因后重试。",
        );
      if (data.error === "slow_down")
        interval = Math.min(interval + 5000, 60000);
      await this.wait(
        Math.min(interval, Math.max(1, deadline - Date.now())),
        signal,
      );
    }
    this.save({ status: "expired", error: "二维码已过期，请重新获取。" });
  }
  private async connect(signal: AbortSignal) {
    const { appId, appSecret, ownerOpenId } = this.record;
    this.save({ ...this.record, status: "connecting", error: undefined });
    const auth = await this.read(
      `${apiRoot}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
      signal,
    );
    if (auth.code !== 0 || !string(auth.tenant_access_token))
      throw new SetupError("应用已创建，但凭据校验未通过。请稍后继续连接。");
    const info = await this.read(
      `${apiRoot}/bot/v3/info`,
      {
        headers: { Authorization: `Bearer ${auth.tenant_access_token}` },
      },
      signal,
    );
    const botId = info.bot?.open_id || info.data?.bot?.open_id;
    if (info.code !== 0 || !string(botId))
      throw new SetupError(
        "应用已创建，但机器人尚未就绪。请在飞书完成启用或发布后继续连接。",
      );
    signal.throwIfAborted();
    // Quiesce old inbound work before replacing its app-scoped identity list.
    await this.feishu.stop();
    if (signal.aborted) {
      void this.feishu.start();
      signal.throwIfAborted();
    }
    const next: RecordState = {
      status: ownerOpenId ? "ready" : "pairing",
      appId,
      ownerOpenId,
      ...(ownerOpenId ? {} : this.newPairingCode()),
    };
    try {
      this.store.db.transaction(() => {
        this.store.setConfig("feishu", {
          appId,
          appSecret,
          botId,
          enabled: true,
        });
        this.store.setConfig("settings", {
          ...this.store.getSettings(),
          trustedFeishuUsers: ownerOpenId ? [ownerOpenId] : [],
        });
        this.store.setConfig(key, next);
      })();
    } catch {
      await this.feishu.start();
      throw new SetupError("保存新连接失败，原连接已恢复，请重试。");
    }
    this.record = next;
    this.changed();
    await this.feishu.start();
  }
  private newPairingCode() {
    return {
      pairingCode: `BRO_${randomBytes(12).toString("hex").toUpperCase()}`,
      pairingExpiresAt: Date.now() + 10 * 60 * 1000,
    };
  }
  pair() {
    if (this.work) throw new Error("请等待当前连接步骤完成。");
    const current = this.store.getConfig<FeishuConfig | null>("feishu", null);
    if (!current?.enabled || current.appId !== this.record.appId)
      throw new Error("请先完成应用连接。");
    this.save({
      ...this.record,
      ...this.newPairingCode(),
      status: "pairing",
      error: undefined,
    });
    return this.state();
  }
  receivePairing(event: any, config: FeishuConfig) {
    const r = this.record,
      m = event.message,
      sender = event.sender?.sender_id?.open_id;
    if (
      r.status !== "pairing" ||
      !r.pairingCode ||
      Date.now() >= (r.pairingExpiresAt || 0) ||
      config.appId !== r.appId ||
      this.store.getConfig<FeishuConfig | null>("feishu", null)?.appId !==
        r.appId ||
      !ownerId(sender) ||
      event.sender?.sender_type === "app" ||
      m?.chat_type !== "p2p" ||
      m?.message_type !== "text"
    )
      return false;
    let text: string;
    try {
      text = JSON.parse(m.content).text?.trim();
    } catch {
      return false;
    }
    const actual = Buffer.from(text || ""),
      expected = Buffer.from(r.pairingCode);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return false;
    this.store.db.transaction(() => {
      this.store.setConfig("settings", {
        ...this.store.getSettings(),
        trustedFeishuUsers: [sender],
      });
      this.store.setConfig(key, {
        status: "ready",
        appId: r.appId,
        ownerOpenId: sender,
      });
    })();
    this.record = { status: "ready", appId: r.appId, ownerOpenId: sender };
    this.changed();
    return true;
  }
  async cancel() {
    this.controller?.abort();
    await this.work;
    if (this.record.appSecret)
      this.save({
        ...this.record,
        status: "error",
        error: "应用已创建，凭据已保留，可继续连接。",
      });
    else if (!["ready", "pairing"].includes(this.record.status))
      this.save({ status: "cancelled" });
    return this.state();
  }
  async clear() {
    await this.cancel();
    this.save({ status: "idle" });
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.work;
  }
}
class SetupError extends Error {}
