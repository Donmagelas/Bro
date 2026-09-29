let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    let result: any;
    if (req.method === "initialize")
      result = {
        protocolVersion: req.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "bro-fixture", version: "1" },
      };
    else if (req.method === "tools/list")
      result = {
        tools: [
          {
            name: "echo",
            description: "A fixture echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
    else if (req.method === "tools/call")
      result = {
        content: [
          { type: "text", text: `MCP_EXECUTED: ${req.params.arguments.text}` },
        ],
      };
    else result = {};
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
  }
}

export {};
