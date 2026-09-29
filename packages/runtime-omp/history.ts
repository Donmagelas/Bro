/** Project the authoritative OMP branch into display messages. Host input
 * metadata decorates user messages without rewriting the model transcript. */
export function displayHistory(manager: any) {
  const messages: any[] = [];
  let inputs: any[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "bro_input")
      inputs.push(entry.data);
    if (entry.type !== "message") continue;
    const message = { id: entry.id, ...entry.message };
    if (message.role === "user" && inputs.length) {
      message.bro = { inputs };
      inputs = [];
    }
    messages.push(message);
  }
  return messages;
}
