const config = require('../../config');
const minecraftCommand = require("../../contracts/minecraftCommand.js");
const giveawayService = require("../../discord/other/giveawayService.js");

class JoinGiveawayCommand extends minecraftCommand {
  constructor(minecraft) {
    super(minecraft);

    this.name = "joingiveaway";
    this.aliases = ["jg"];
    this.description = "Join a giveaway by ID.";
    this.options = [
      {
        name: '"id"',
        description: 'Example: !joingiveaway "1"',
        required: true
      }
    ];
  }

  getUsage() {
    return `Usage: ${config.minecraft.bot.prefix}joingiveaway "id"`;
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

      const result = await giveawayService.joinFromIngame({
        giveawayId: id,
        username: player
      });
      if (!result.ok) {
        return this.send(result.reason);
      }

      return this.send(`Joined giveaway #${id}.`);
    } catch (error) {
      return this.send(error?.message || String(error));
    }
  }
}

module.exports = JoinGiveawayCommand;
