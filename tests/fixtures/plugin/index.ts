export default function (api: any) {
  api.registerTool({
    name: "bro_fixture_greet",
    label: "Fixture",
    description: "Return a deterministic probe result",
    loadMode: "essential",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return {
        content: [{ type: "text", text: "PLUGIN_EXECUTED" }],
        details: {},
      };
    },
  });
}
