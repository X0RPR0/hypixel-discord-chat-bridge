const minecraftCommand = require("../../contracts/minecraftCommand.js");
const giveawayService = require("../../discord/other/giveawayService.js");

class GiveawaysCommand extends minecraftCommand {
  constructor(minecraft) {
    super(minecraft);

    this.name = "giveaways";
    this.aliases = ["activegiveaways", "ags"];
    this.description = "List active giveaways.";
    this.options = [];
  }

  async onCommand(player) {
    try {
      const membership = await giveawayService.getIngameGuildMembership(player);
      if (!membership) {
        return this.send("Only guild members can use giveaway commands.");
      }

      const active = giveawayService.getActiveGiveaways();
      if (!active.length) {
        return this.send("No active giveaways.");
      }

      const lines = active.map(
        (giveaway) =>
          `#${giveaway.id} ${giveaway.prize} | Entrants: ${giveawayService.getEntrantCount(giveaway)} | Winners: ${
            giveaway.winnerCount
          } | Ends in ${giveawayService.formatRemaining(giveaway.endsAt)}`
      );
      return this.send(lines.join(" || "));
    } catch (error) {
      return this.send(error?.message || String(error));
    }
  }
}

module.exports = GiveawaysCommand;
