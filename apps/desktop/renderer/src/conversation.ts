import type { ChatMessage, Input } from "../../../../packages/contracts";

export type StreamMessage = ChatMessage & { streaming: boolean };
export type OutgoingMessage = Pick<
  Input,
  "id" | "text" | "attachments" | "annotations"
> & {
  queued: boolean;
};
export type DisplayMessage = ChatMessage & {
  transient?: boolean;
  streaming?: boolean;
  delivery?: Input["status"] | "sending";
  error?: string;
};

export function messageText(message: ChatMessage): string {
  if (
    message.role === "user" &&
    message.bro?.inputs.every((i) => i.text !== undefined)
  )
    return message.bro.inputs.map((i) => i.text).join("\n\n");
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

// Match each buffered response once. Content matching also handles OMP display
// transformations while timestamps distinguish repeated answers in later turns.
export function uncommittedMessages(
  history: ChatMessage[],
  buffered: StreamMessage[],
) {
  const matched = new Set<number>();
  return buffered.filter((message) => {
    const index = history.findIndex(
      (saved, index) =>
        !matched.has(index) &&
        saved.role === message.role &&
        saved.timestamp === message.timestamp &&
        messageText(saved) === messageText(message),
    );
    if (index < 0) return true;
    matched.add(index);
    return false;
  });
}

export function projectConversation(
  history: ChatMessage[],
  buffered: StreamMessage[],
  inputs: Input[],
  outgoing: OutgoingMessage | null,
  starting: boolean,
) {
  const represented = new Set(
    history.flatMap((m) => m.bro?.inputs.map((i) => i.id) || []),
  );
  const messages: DisplayMessage[] = history
    .filter((m) => ["user", "assistant", "toolResult"].includes(m.role))
    .map((m) => {
      const input = inputs.find((i) =>
        m.bro?.inputs.some((p) => p.id === i.id),
      );
      return { ...m, delivery: input?.status, error: input?.error };
    });
  const pending = inputs.filter((i) => !represented.has(i.id));
  // During worker startup the first queued input is already the current turn.
  const first =
    starting && !inputs.some((i) => i.status === "running")
      ? pending.find((i) => i.status === "queued")?.id
      : undefined;
  const queue = pending.filter((i) => i.status === "queued" && i.id !== first);
  const asMessage = (
    input: Partial<Input>,
    delivery: DisplayMessage["delivery"],
  ): DisplayMessage => ({
    id: `input-${input.id}`,
    role: "user",
    content: input.text || "",
    timestamp: input.createdAt,
    bro: { inputs: [input] },
    delivery,
    error: input.error,
  });
  for (const input of pending)
    if (input.status !== "queued" || input.id === first)
      messages.push(asMessage(input, input.status));
  // An optimistic message disappears as soon as its accepted input or history
  // arrives, even when that event beats the HTTP response.
  const sending =
    outgoing &&
    !represented.has(outgoing.id) &&
    !inputs.some((i) => i.id === outgoing.id)
      ? outgoing
      : null;
  if (sending && !sending.queued) messages.push(asMessage(sending, "sending"));
  for (const message of uncommittedMessages(history, buffered))
    messages.push({ ...message, transient: true });
  return { messages, queue, sending: sending?.queued ? sending : null };
}
