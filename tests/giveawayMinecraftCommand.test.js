/* eslint-env jest */

jest.mock("../src/discord/other/giveawayService.js", () => ({
  canStartFromIngame: jest.fn(async () => ({ ok: true })),
  parseDuration: jest.fn((value) => (value === "1d" ? 86400000 : null)),
  getSettings: jest.fn(() => ({ defaultChannelId: "123" })),
  createGiveaway: jest.fn(async () => ({ id: 1, prize: "Coins", winnerCount: 1, endsAt: Date.now() + 86400000 })),
  formatRemaining: jest.fn(() => "1 day")
}));

const giveawayService = require("../src/discord/other/giveawayService.js");
const GiveawayCommand = require("../src/minecraft/commands/giveawayCommand.js");

describe("minecraft giveaway command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns usage when no args", async () => {
    const command = new GiveawayCommand();
    command.send = jest.fn();

    await command.onCommand("Player", "!giveaway");

    expect(command.send).toHaveBeenCalled();
    expect(command.send.mock.calls[0][0]).toContain("Usage:");
  });

  test("uses defaults when only prize is provided", async () => {
    const command = new GiveawayCommand();
    command.send = jest.fn();

    await command.onCommand("Player", '!giveaway "Coins"');

    expect(giveawayService.parseDuration).toHaveBeenCalledWith("1d");
    expect(giveawayService.createGiveaway).toHaveBeenCalledWith(
      expect.objectContaining({
        prize: "Coins",
        winnerCount: 1
      })
    );
  });
});
