const config = require("../../../config.json");
const giveawayService = require("../other/giveawayService.js");
const { startWeeklyFreeCarryReset, stopWeeklyFreeCarryReset } = require("../other/freecarryWeeklyReset.js");

class StateHandler {
  constructor(discord) {
    this.discord = discord;
  }

  async onReady() {
    console.discord("Client ready, logged in as " + this.discord.client.user.tag);
    this.discord.client.user.setPresence({
      activities: [{ name: `/help` }]
    });

    global.guild = await client.guilds.fetch(config.discord.bot.serverID);
    console.discord(`Guild ready, successfully fetched ${guild.name}`);

    const channel = await this.getChannel("Guild");
    if (channel === undefined) {
      return console.error(`Channel "Guild" not found!`);
    }

    if (config.verification.inactivity.enabled) require("../other/removeExpiredInactivity.js");
    if (config.verification.autoRoleUpdater.enabled) require("../other/updateUsers.js");
    if (config.rankup?.enabled && config.rankup?.dailySync?.enabled) require("../other/rankupDailySync.js");
    if (config.statsChannels.enabled) require("../other/statsChannels.js");
    require("../other/leaderboardUpdater.js");
    await this.discord.joinRequestManager.initialize();
    await this.discord.carryService.db.initialize();
    this.discord.ticketService.initialize(this.discord.client);
    this.discord.carryService.initialize(this.discord.client);
    giveawayService.initialize(this.discord.client);
    await this.discord.ticketService.publishDashboard().catch(() => {});
    await this.discord.carryService.publishCarryDashboard().catch(() => {});
    await this.discord.carryService.publishCarrierDashboard().catch(() => {});
    startWeeklyFreeCarryReset(this.discord.carryService);

    channel.send({
      embeds: [
        {
          author: { name: `Chat Bridge is Online` },
          color: 2067276
        }
      ]
    });
  }

  async onClose() {
    this.discord.joinRequestManager.stop();
    this.discord.carryService.shutdown();
    this.discord.ticketService.shutdown();
    stopWeeklyFreeCarryReset();
    if (this.discord.carryService?.db?.close) {
      this.discord.carryService.db.close();
    }
    giveawayService.shutdown();

    const channel = await this.getChannel("Guild");
    if (channel === undefined) {
      return console.error(`Channel "Guild" not found!`);
    }

    await channel.send({
      embeds: [
        {
          author: { name: `Chat Bridge is Offline` },
          color: 15548997
        }
      ]
    });
  }

  async getChannel(type) {
    if (typeof type !== "string" || type === undefined) {
      console.error(`Channel type must be a string! Received: ${type}`);
      return;
    }

    switch (type.replace(/§[0-9a-fk-or]/g, "").trim()) {
      case "Guild":
        return this.discord.client.channels.cache.get(config.discord.channels.guildChatChannel);
      case "Officer":
        return this.discord.client.channels.cache.get(config.discord.channels.officerChannel);
      case "Logger":
        return this.discord.client.channels.cache.get(config.discord.channels.loggingChannel);
      default:
        return this.discord.client.channels.cache.get(config.discord.channels.debugChannel);
    }
  }
}

module.exports = StateHandler;
