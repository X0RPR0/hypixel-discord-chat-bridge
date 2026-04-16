const MinecraftManager = require("./minecraft/MinecraftManager.js");
const { existsSync, mkdirSync, writeFileSync } = require("fs");
const DiscordManager = require("./discord/DiscordManager.js");
const webManager = require("./web/WebsiteManager.js");
const { carryDatabase } = require("./discord/other/carryDatabase.js");

class Application {
  constructor() {
    require("./Configuration.js");
    require("./Updater.js");
    require("./Logger.js");
    if (!existsSync("./data/")) mkdirSync("./data/", { recursive: true });
    if (!existsSync("./data/linked.json")) writeFileSync("./data/linked.json", JSON.stringify({}));
    if (!existsSync("./data/inactivity.json")) writeFileSync("./data/inactivity.json", JSON.stringify({}));
    if (!existsSync("./data/activityTracker.json")) writeFileSync("./data/activityTracker.json", JSON.stringify({ version: 1, users: {} }, null, 2));
    if (!existsSync("./data/guildMemberHistory.json")) writeFileSync("./data/guildMemberHistory.json", JSON.stringify({ version: 1, members: {} }, null, 2));
    if (!existsSync("./data/leaderboard.json")) {
      writeFileSync(
        "./data/leaderboard.json",
        JSON.stringify({ version: 1, channelId: null, messageId: null, metric: "score", top: 15, lastSnapshot: null, snapshots: [] }, null, 2)
      );
    }
    if (!existsSync("./roastConfig.json")) {
      writeFileSync("./roastConfig.json", JSON.stringify({}, null, 2));
    }
    if (!existsSync("./data/joinRequests.json")) writeFileSync("./data/joinRequests.json", JSON.stringify({ version: 1, panelMessageId: null, requests: [] }));
    if (!existsSync("./data/giveaways.json")) {
      writeFileSync(
        "./data/giveaways.json",
        JSON.stringify(
          {
            version: 1,
            settings: {
              starterMode: "everyone",
              allowedIngameStarterRanks: [],
              defaultChannelId: null
            },
            activeGiveaways: [],
            usedIds: []
          },
          null,
          2
        )
      );
    }
  }

  async register() {
    await carryDatabase.initialize();
    this.discord = new DiscordManager(this);
    this.minecraft = new MinecraftManager(this);
    this.web = new webManager(this);

    this.discord.setBridge(this.minecraft);
    this.minecraft.setBridge(this.discord);
  }

  async connect() {
    this.discord.connect();
    this.minecraft.connect();
    this.web.connect();
  }
}

module.exports = new Application();
