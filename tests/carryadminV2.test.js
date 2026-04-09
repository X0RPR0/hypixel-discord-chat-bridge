const { MessageFlags } = require("discord.js");
const carryadmin = require("../src/discord/commands/carryadminCommand.js");

describe("carryadmin command V2 responses", () => {
  test("help response is Components V2 without embeds", async () => {
    const editReply = jest.fn().mockResolvedValue(null);
    const interaction = {
      client: {
        carryService: {},
        ticketService: {}
      },
      options: {
        getSubcommandGroup: () => false,
        getSubcommand: () => "help"
      },
      editReply
    };

    await carryadmin.execute(interaction);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0][0];
    expect(payload.embeds).toBeUndefined();
    expect(Array.isArray(payload.components)).toBe(true);
    expect(Number(payload.flags) & Number(MessageFlags.IsComponentsV2)).toBe(Number(MessageFlags.IsComponentsV2));
  });
});
