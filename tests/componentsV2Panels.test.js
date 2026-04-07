const { MessageFlags } = require("discord.js");
const { makePanel, panelPayload, infoPayload, actionButton } = require("../src/discord/other/componentsV2Panels.js");

describe("componentsV2Panels", () => {
  test("panelPayload marks IsComponentsV2 and has components", () => {
    const panel = makePanel({
      title: "Test",
      sections: [{ title: "Section", lines: ["line"] }],
      actions: [actionButton("x:test", "Test")]
    });
    const payload = panelPayload(panel);
    expect(payload.embeds).toBeUndefined();
    expect(Array.isArray(payload.components)).toBe(true);
    expect(Number(payload.flags) & Number(MessageFlags.IsComponentsV2)).toBe(Number(MessageFlags.IsComponentsV2));
  });

  test("infoPayload supports ephemeral v2 responses", () => {
    const payload = infoPayload({
      title: "Info",
      lines: ["hello"],
      ephemeral: true
    });
    expect(payload.embeds).toBeUndefined();
    expect(Number(payload.flags) & Number(MessageFlags.IsComponentsV2)).toBe(Number(MessageFlags.IsComponentsV2));
    expect(Number(payload.flags) & Number(MessageFlags.Ephemeral)).toBe(Number(MessageFlags.Ephemeral));
  });
});

