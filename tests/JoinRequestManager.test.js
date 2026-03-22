const fs = require("fs");
const path = require("path");
const { describe, it, expect, beforeAll, afterAll, beforeEach, jest: jestGlobals } = require("@jest/globals");

const configPath = path.resolve(process.cwd(), "config.json");
let originalConfig = null;

beforeAll(() => {
  if (fs.existsSync(configPath)) {
    originalConfig = fs.readFileSync(configPath, "utf8");
  }

  const testConfig = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "config.example.json"), "utf8"));
  testConfig.discord.joinRequests = {
    enabled: true,
    forumChannelId: "forum",
    moderatorRoleIds: ["mod-role"],
    statusTagIds: {
      pending: "tag-pending",
      accepted_discord: "tag-accepted-discord",
      accepted_ingame: "tag-accepted-ingame",
      denied: "tag-denied",
      expired: "tag-expired"
    },
    requestTimeoutMinutes: 5,
    mentionOnCreate: "@here",
    trackIngameAcceptance: true,
    allowDiscordSelfRequest: true,
    requestEntryChannelId: "entry",
    requestEntryMessageId: ""
  };

  fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2));
});

afterAll(() => {
  if (originalConfig === null) {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    return;
  }

  fs.writeFileSync(configPath, originalConfig);
});

describe("JoinRequestManager", () => {
  let JoinRequestManager;
  let manager;

  beforeAll(() => {
    jestGlobals.resetModules();
    JoinRequestManager = require("../src/discord/other/joinRequestManager.js").JoinRequestManager;
  });

  beforeEach(() => {
    manager = new JoinRequestManager({ client: {} });
    manager.saveState = jestGlobals.fn();
    manager.updateRequestMessage = jestGlobals.fn(async () => {});
    global.bot = { chat: jestGlobals.fn() };
  });

  it("parses join request action custom IDs", () => {
    expect(JoinRequestManager.parseActionCustomId("joinreq:accept:abc123")).toEqual({ action: "accept", requestId: "abc123" });
    expect(JoinRequestManager.parseActionCustomId("joinreq:deny:abc123")).toEqual({ action: "deny", requestId: "abc123" });
    expect(JoinRequestManager.parseActionCustomId("joinreq:reinvite:abc123")).toEqual({ action: "reinvite", requestId: "abc123" });
    expect(JoinRequestManager.parseActionCustomId("joinreq:invalid:abc123")).toBeNull();
  });

  it("checks moderator permissions against configured role list", () => {
    const allowed = manager.canModerate({
      roles: { cache: [{ id: "mod-role" }, { id: "other-role" }] }
    });
    const denied = manager.canModerate({
      roles: { cache: [{ id: "viewer-role" }] }
    });

    expect(allowed).toBe(true);
    expect(denied).toBe(false);
  });

  it("resolves status tag from configured tag IDs", () => {
    const forum = {
      availableTags: [
        { id: "tag-pending", name: "Pending" },
        { id: "tag-denied", name: "Denied" }
      ]
    };

    expect(manager.resolveStatusTagId("pending", forum)).toBe("tag-pending");
    expect(manager.resolveStatusTagId("denied", forum)).toBe("tag-denied");
  });

  it("falls back to status tag name match when configured ID is unavailable", () => {
    const forum = {
      availableTags: [{ id: "x1", name: "Accepted In-game" }]
    };

    expect(manager.resolveStatusTagId("accepted_ingame", forum)).toBe("x1");
  });

  it("accept action updates status and dispatches guild accept command", async () => {
    manager.state.requests = [
      {
        requestId: "req-1",
        username: "Alexw11",
        status: "pending",
        reinviteCount: 0,
        actions: [],
        expiresAt: new Date().toISOString()
      }
    ];

    const interaction = {
      member: { roles: { cache: [{ id: "mod-role" }] } },
      user: { id: "123", tag: "Mod#0001" },
      reply: jestGlobals.fn(async () => {})
    };

    await manager.handleModeratorAction({ action: "accept", requestId: "req-1", interaction });

    expect(global.bot.chat).toHaveBeenCalledWith("/g accept Alexw11");
    expect(manager.state.requests[0].status).toBe("accepted_discord");
    expect(manager.state.requests[0].actions.at(-1).action).toBe("accepted_discord");
    expect(interaction.reply).toHaveBeenCalled();
  });

  it("reinvite action resets timeout and increments count", async () => {
    const oldExpiry = new Date(Date.now() - 60_000).toISOString();
    manager.state.requests = [
      {
        requestId: "req-2",
        username: "Gensxis_",
        status: "expired",
        reinviteCount: 1,
        actions: [],
        expiresAt: oldExpiry
      }
    ];

    const interaction = {
      member: { roles: { cache: [{ id: "mod-role" }] } },
      user: { id: "999", tag: "Staff#0001" },
      reply: jestGlobals.fn(async () => {})
    };

    await manager.handleModeratorAction({ action: "reinvite", requestId: "req-2", interaction });

    expect(global.bot.chat).toHaveBeenCalledWith("/g invite Gensxis_");
    expect(manager.state.requests[0].status).toBe("pending");
    expect(manager.state.requests[0].reinviteCount).toBe(2);
    expect(new Date(manager.state.requests[0].expiresAt).getTime()).toBeGreaterThan(new Date(oldExpiry).getTime());
  });
});
