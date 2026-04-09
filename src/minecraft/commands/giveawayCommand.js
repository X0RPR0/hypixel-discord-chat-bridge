const config = require("../../../config.json");
const minecraftCommand = require("../../contracts/minecraftCommand.js");
const giveawayService = require("../../discord/other/giveawayService.js");

function parseCommandTokens(raw) {
  const tokens = [];
  const regex = /"([^"]*)"|“([^”]*)”|(\S+)/g;
  let match = null;
  while ((match = regex.exec(raw)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }

  return tokens.filter((token) => token.length > 0);
}

function parseGiveawayArgs(raw) {
  const trimmed = String(raw || "").trim();
  const strict = trimmed.match(/^"([^"]+)"(?:\s+"([^"]+)")?(?:\s+"([^"]+)")?\s*$/);
  if (strict) {
    return [strict[1], strict[2] || "1d", strict[3] || "1"];
  }

  const tokens = parseCommandTokens(trimmed);
  if (!tokens.length) {
    return [];
  }

  return [tokens[0], tokens[1] || "1d", tokens[2] || "1"];
}

class GiveawayCommand extends minecraftCommand {
  constructor(minecraft) {
    super(minecraft);

    this.name = "giveaway";
    this.aliases = ["gaw"];
    this.description = "Start a giveaway.";
    this.options = [
      {
        name: '"prize" ["time"] ["winners"]',
        description: 'Example: !giveaway "1x Booster" "2h" "2"',
        required: false
      }
    ];
  }

  getUsage() {
    return `Usage: ${config.minecraft.bot.prefix}giveaway "prize" ["time"] ["winners"]`;
  }

  async onCommand(player, message) {
    try {
      const permission = await giveawayService.canStartFromIngame(player);
      if (!permission.ok) {
        return this.send(permission.reason);
      }

      const content = message.split(" ").slice(1).join(" ").trim();
      if (!content) {
        return this.send(this.getUsage());
      }

      const tokens = parseGiveawayArgs(content);
      if (tokens.length === 0) {
        return this.send(this.getUsage());
      }

      const prize = tokens[0];
      const timeText = tokens[1] || "1d";
      const winnersText = tokens[2] || "1";
      const durationMs = giveawayService.parseDuration(timeText);
      if (!durationMs) {
        return this.send(`Invalid time format. ${this.getUsage()}`);
      }

      const winners = Number(winnersText);
      if (!Number.isInteger(winners) || winners <= 0) {
        return this.send(`Invalid winners value. ${this.getUsage()}`);
      }

      const settings = giveawayService.getSettings();
      if (!settings.defaultChannelId) {
        return this.send("No default giveaway channel is set. Use /giveaway channel on Discord.");
      }

      const giveaway = await giveawayService.createGiveaway({
        prize,
        durationMs,
        winnerCount: winners,
        channelId: settings.defaultChannelId,
        createdBy: {
          source: "ingame",
          username: player
        }
      });

      return this.send(
        `Started giveaway #${giveaway.id}: ${giveaway.prize} | Winners: ${giveaway.winnerCount} | Ends in ${giveawayService.formatRemaining(giveaway.endsAt)}`
      );
    } catch (error) {
      return this.send(error?.message || String(error));
    }
  }
}

module.exports = GiveawayCommand;
