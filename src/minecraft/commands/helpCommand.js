const minecraftCommand = require("../../contracts/minecraftCommand.js");
const config = require('../../config');

class HelpCommand extends minecraftCommand {
  /** @param {import("minecraft-protocol").Client} minecraft */
  constructor(minecraft) {
    super(minecraft);
    this.name = "help";
    this.aliases = ["commands", "cmds", "h"];
    this.description = "Show available in-game commands.";
    this.options = [
      {
        name: "command",
        description: "Optional command name for detailed help",
        required: false
      }
    ];
  }

  async onCommand(player, message) {
    const args = this.getArgs(message);
    const requested = String(args[0] || "")
      .trim()
      .toLowerCase();
    const handler = this.minecraft?.chatHandler?.command;
    const commands = handler?.commands;

    if (!commands || typeof commands.values !== "function") {
      return this.send("Help is temporarily unavailable.");
    }

    if (requested) {
      const byName = commands.get(requested);
      const byAlias = commands.find((cmd) => Array.isArray(cmd.aliases) && cmd.aliases.includes(requested));
      const command = byName || byAlias;
      if (!command) {
        return this.send(`Unknown command: ${requested}. Use ${config.minecraft.bot.prefix}help for list.`);
      }

      const usage = typeof command.getUsage === "function" ? command.getUsage() : `${config.minecraft.bot.prefix}${command.name}`;
      const aliasText = Array.isArray(command.aliases) && command.aliases.length ? ` | aliases: ${command.aliases.join(", ")}` : "";
      const desc = command.description || "No description.";
      return this.send(`${usage} | ${desc}${aliasText}`);
    }

    const prefix = config.minecraft.bot.prefix;
    const names = [...commands.values()]
      .map((cmd) =>
        String(cmd.name || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    const uniqueNames = [...new Set(names)];
    const chunkSize = 18;
    for (let i = 0; i < uniqueNames.length; i += chunkSize) {
      const chunk = uniqueNames.slice(i, i + chunkSize);
      const header = i === 0 ? `Commands (${uniqueNames.length}): ` : "More: ";
      await this.send(`${header}${chunk.map((name) => `${prefix}${name}`).join(", ")}`);
    }
  }
}

module.exports = HelpCommand;
