const config = require('../../config');
const minecraftCommand = require("../../contracts/minecraftCommand.js");

class CarryCommand extends minecraftCommand {
  constructor(minecraft) {
    super(minecraft);

    this.name = "carry";
    this.aliases = ["carries"];
    this.description = "Request a carry from in-game.";
    this.options = [
      {
        name: "request <type> <amount>",
        description: "Example: !carry request dungeons 1",
        required: true
      }
    ];
  }

  getUsage() {
    return `Usage: ${config.minecraft.bot.prefix}carry request <type> <amount>`;
  }

  async onCommand(player, message) {
    try {
      const args = this.getArgs(message);
      if (args[0] !== "request") {
        return this.send(this.getUsage());
      }

      const type = String(args[1] || "")
        .trim()
        .toLowerCase();
      const amount = Number(args[2]);
      if (!type || !Number.isInteger(amount) || amount <= 0) {
        return this.send(this.getUsage());
      }

      const carryService = global.client?.carryService;
      if (!carryService) {
        return this.send("Carry service is currently unavailable.");
      }

      const result = await carryService.createCarryFromMinecraft({
        playerUsername: player,
        carryType: type,
        amount
      });

      if (!result.ok) {
        return this.send(result.reason || "Failed to create carry request.");
      }

      const etaMinutes = Math.max(1, Math.round(Number(result.etaMs || 0) / 60000));
      return this.send(`Carry request #${result.carryId} created. Final price: ${result.finalPrice}. ETA: ~${etaMinutes}m.`);
    } catch (error) {
      return this.send(error?.message || String(error));
    }
  }
}

module.exports = CarryCommand;
