/* eslint-env jest */

const fs = require("fs");
const path = require("path");
const { GiveawayService } = require("../src/discord/other/giveawayService.js");
const config = require("../config.json");

function makeMember(userId, roleIds = []) {
  return {
    user: { id: userId, tag: `${userId}#0001` },
    roles: {
      cache: {
        map: (mapper) => roleIds.map((id) => mapper({ id }))
      }
    }
  };
}

describe("giveaway service", () => {
  const statePath = path.resolve(process.cwd(), "data/test-giveaways.json");

  afterEach(() => {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  });

  test("reuses freed ids", () => {
    const service = new GiveawayService({ statePath, now: () => 1000 });
    service.loadState();
    const first = service.allocateId();
    service.freeId(first);
    const second = service.allocateId();
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  test("parses duration using ms format", () => {
    const service = new GiveawayService({ statePath });
    expect(service.parseDuration("1d")).toBe(86400000);
    expect(service.parseDuration("2h")).toBe(7200000);
    expect(service.parseDuration("invalid")).toBeNull();
  });

  test("discord starter permission respects bridge admin mode", () => {
    const service = new GiveawayService({ statePath });
    service.loadState();
    service.updateSettings({ starterMode: "bridge_admin_only" });

    const denied = service.canStartFromDiscord(makeMember("non-admin", []));
    expect(denied.ok).toBe(false);

    const allowed = service.canStartFromDiscord(makeMember("admin", [config.discord.commands.commandRole]));
    expect(allowed.ok).toBe(true);
  });

  test("join from discord enforces required role", async () => {
    const service = new GiveawayService({ statePath, now: () => 1000 });
    const state = service.loadState();
    state.usedIds = [1];
    state.activeGiveaways = [
      {
        id: 1,
        prize: "Test Prize",
        createdAt: 1000,
        endsAt: 9999999,
        winnerCount: 1,
        requiredRoleId: "required-role",
        channelId: "chan-1",
        messageId: null,
        createdBy: { source: "discord", username: null, discordId: "x" },
        entrants: { discord: [], ingame: [] }
      }
    ];
    service.saveState();

    const result = await service.joinFromDiscord({
      giveawayId: 1,
      member: makeMember("u1", [])
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("required role");
  });
});
