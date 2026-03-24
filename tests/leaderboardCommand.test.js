/* eslint-env jest */

jest.mock("../src/discord/other/leaderboardService.js", () => ({
  buildLeaderboard: jest.fn(async () => ({ embed: { title: "x" }, metric: "score", top: 15 })),
  setBinding: jest.fn()
}));

const command = require("../src/discord/commands/leaderboardCommand.js");
const leaderboardService = require("../src/discord/other/leaderboardService.js");

describe("leaderboard command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("preview mode does not rebind target", async () => {
    const interaction = {
      options: {
        getString: jest.fn(() => null),
        getBoolean: jest.fn(() => false),
        getInteger: jest.fn(() => null)
      },
      editReply: jest.fn()
    };

    await command.execute(interaction);

    expect(leaderboardService.buildLeaderboard).toHaveBeenCalledWith({ metric: undefined, top: undefined, persistSnapshot: false });
    expect(leaderboardService.setBinding).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test("setup mode rebinds target", async () => {
    const sentMessage = { id: "msg-1" };
    const interaction = {
      options: {
        getString: jest.fn(() => "score"),
        getBoolean: jest.fn(() => true),
        getInteger: jest.fn(() => 20)
      },
      channel: {
        id: "chan-1",
        send: jest.fn(async () => sentMessage)
      },
      editReply: jest.fn()
    };

    await command.execute(interaction);

    expect(leaderboardService.buildLeaderboard).toHaveBeenCalledWith({ metric: "score", top: 20, persistSnapshot: true });
    expect(leaderboardService.setBinding).toHaveBeenCalledWith({ channelId: "chan-1", messageId: "msg-1", metric: "score", top: 15 });
  });
});
