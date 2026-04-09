const command = require("../src/discord/commands/carrySetupCommand.js");

describe("carry-setup command", () => {
  test("delegates rendering to carrySetupService", async () => {
    const show = jest.fn().mockResolvedValue(null);
    const interaction = {
      client: { carrySetupService: { show } },
      editReply: jest.fn()
    };

    await command.execute(interaction);
    expect(show).toHaveBeenCalledWith(interaction);
  });
});
