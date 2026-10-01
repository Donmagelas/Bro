import type { ModelActivity } from "../contracts";

export function modelActivity(
  event: any,
  previous?: ModelActivity,
): ModelActivity | undefined {
  if (event.type === "bro_model_request")
    return { ...previous, phase: "waiting", since: Date.now() };
  if (event.type === "bro_model_request_failed")
    return { ...previous, phase: "retrying", since: Date.now() };
  if (event.type === "auto_retry_start")
    return {
      phase: "retrying",
      since: Date.now(),
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
    };
  if (event.type === "turn_start")
    return { ...previous, phase: "waiting", since: Date.now() };
  if (event.type === "message_update" && event.message?.role === "assistant") {
    const hasOutput = event.message.content?.some(
      (c: any) =>
        (c.type === "text" && c.text) || (c.type === "thinking" && c.thinking),
    );
    if (hasOutput && previous?.phase !== "responding")
      return { phase: "responding", since: Date.now() };
  }
  if (
    event.type === "tool_execution_start" ||
    (event.type === "auto_retry_end" && event.success) ||
    (event.type === "agent_end" && event.isTerminal !== false)
  )
    return undefined;
  return previous;
}

export function modelFailure(message: string): string {
  if (/timeout|timed out|no (?:stream )?events|stalled/i.test(message))
    return "模型响应超时，本次未完成。请检查网络或稍后重试。";
  if (
    /fetch failed|failed to fetch|unable to connect|connection|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|proxy/i.test(
      message,
    )
  )
    return "无法连接模型服务，本次未完成。请检查网络和代理，恢复后重新发送消息。";
  if (/\b5\d\d\b|service unavailable|server.error|overloaded/i.test(message))
    return "模型服务暂时不可用，本次未完成。请稍后重新发送消息。";
  if (
    /\b401\b|unauthorized|invalid.*(?:key|token)|token.*expired|invalid_grant/i.test(
      message,
    )
  )
    return "模型身份验证失败，请检查 API Key 或重新登录 ChatGPT。";
  if (/\b429\b|rate.limit|quota|usage.limit/i.test(message))
    return "模型服务限流或额度不足，本次未完成。请稍后重试或切换模型连接。";
  return message;
}
