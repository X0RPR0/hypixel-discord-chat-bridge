/* eslint-env jest */

const MinecraftCommand = require("../src/contracts/minecraftCommand.js");

class DummyCommand extends MinecraftCommand {
  onCommand() {}
}

describe("minecraft command send", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.bot = {
      _client: { chat: {} },
      once: jest.fn(),
      removeListener: jest.fn(),
      chat: jest.fn()
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("uses /msg when source is pm", async () => {
    const command = new DummyCommand();
    command.source = "pm";
    command.replyTarget = "Kimberlyx3";

    const promise = command.send('Usage: !giveaway "prize" ["time"] ["winners"]');
    jest.advanceTimersByTime(600);
    await promise;

    expect(bot.chat).toHaveBeenCalledWith('/msg Kimberlyx3 Usage: !giveaway "prize" ["time"] ["winners"]');
  });
});
