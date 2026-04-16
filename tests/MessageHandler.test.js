const { describe, it, expect, beforeEach } = require("@jest/globals");

jest.mock("../src/contracts/linkedStore.js", () => ({
  getAllLinks: jest.fn(() => ({})),
  getUuidByDiscordId: jest.fn()
}));

jest.mock("../src/discord/other/carryDatabase.js", () => ({
  carryDatabase: {
    getBinding: jest.fn(() => "[]")
  }
}));

const { getUuidByDiscordId } = require("../src/contracts/linkedStore.js");
const { carryDatabase } = require("../src/discord/other/carryDatabase.js");
const MessageHandler = require("../src/discord/handlers/MessageHandler.js");

describe("MessageHandler bridge gating helpers", () => {
  let handler;

  beforeEach(() => {
    handler = new MessageHandler({});
    getUuidByDiscordId.mockReset();
    carryDatabase.getBinding.mockReturnValue("[]");
  });

  it("detects linked bridge users", () => {
    getUuidByDiscordId.mockReturnValueOnce("uuid-123");
    expect(handler.isLinkedBridgeUser("1")).toBe(true);
  });

  it("detects unlinked bridge users", () => {
    getUuidByDiscordId.mockReturnValueOnce(null);
    expect(handler.isLinkedBridgeUser("1")).toBe(false);
  });

  it("detects guild-muted users from stored uuid set", () => {
    getUuidByDiscordId.mockReturnValueOnce("abc");
    carryDatabase.getBinding.mockReturnValueOnce(JSON.stringify(["abc"]));
    expect(
      handler.isGuildMutedFromBridge({
        author: { id: "1", username: "UserA" },
        member: { displayName: "UserA" }
      })
    ).toBe(true);
  });

  it("detects guild-muted users from stored normalized username", () => {
    getUuidByDiscordId.mockReturnValueOnce(null);
    carryDatabase.getBinding.mockReturnValueOnce(JSON.stringify(["jamesien"]));
    expect(
      handler.isGuildMutedFromBridge({
        author: { id: "1", username: "JaMeSiEn" },
        member: { displayName: "Jamesien" }
      })
    ).toBe(true);
  });
});
