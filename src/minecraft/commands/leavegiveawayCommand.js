const config = require('../../config');
const minecraftCommand = require("../../contracts/minecraftCommand.js");
const giveawayService = require("../../discord/other/giveawayService.js");

class LeaveGiveawayCommand extends minecraftCommand {
  constructor(minecraft) {
    super(minecraft);

    this.name = "leavegiveaway";
    this.aliases = ["lg"];
    this.description = "Leave a giveaway by ID.";
    this.options = [
      {
        name: '"id"',
        description: 'Example: !leavegiveaway "1"',
        required: true
      }
    ];
  }

  getUsage() {
    return `Usage: ${config.minecraft.bot.prefix}leavegiveaway "id"`;
  }

  async onCommand(player, message) {
    try {
      const rawId = message.split(" ").slice(1).join(" ").replaceAll('"', "").trim();
      if (!rawId) {
        return this.send(this.getUsage());
      }

      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        return this.send(this.getUsage());
      }

      const result = await giveawayService.leaveFromIngame({
        giveawayId: id,
        username: player
      });
      if (!result.ok) {
        return this.send(result.reason);
      }

      return this.send(`Left giveaway #${id}.`);
    } catch (error) {
      return this.send(error?.message || String(error));
    }
  }
}

module.exports = LeaveGiveawayCommand;
