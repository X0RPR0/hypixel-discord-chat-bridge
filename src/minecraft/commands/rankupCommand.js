const minecraftCommand = require("../../contracts/minecraftCommand.js");
const {
  getRankupConfig,
  getBotGuildSnapshot,
  getInvokerGuildRankByUsername,
  isAllowedInvokerRank,
  rankupSingle,
  rankupAll
} = require("../../contracts/rankupService.js");

function formatSingleResult(result) {
  if (result.status === "updated") {
    return `${result.username}: ${result.currentGuildRank} -> ${result.targetGuildRank} (SB ${result.skyblockLevel})`;
  }

  if (result.status === "unchanged") {
    return `${result.username}: already ${result.targetGuildRank} (SB ${result.skyblockLevel})`;
  }

  if (result.status === "skipped_protected") {
    return `You already have a higher rank, silly! (${result.currentGuildRank})`;
  }

  return `${result.username}: ${result.reason}`;
}

class RankupCommand extends minecraftCommand {
  /** @param {import("minecraft-protocol").Client} minecraft */
  constructor(minecraft) {
    super(minecraft);

    this.name = "rankup";
    this.aliases = [];
    this.description = "Sync guild rank from SkyBlock level thresholds.";
    this.options = [
      {
        name: "username|all",
        description: "Optional target username or `all` for full guild sync",
        required: false
      }
    ];
  }

  async onCommand(player, message) {
    const rankupConfig = getRankupConfig();
    if (!rankupConfig.enabled || !rankupConfig.manual.minecraftEnabled) {
      return this.send("Rankup is currently disabled.");
    }

    const arg = this.getArgs(message)[0];
    const adminMode = typeof arg === "string" && arg.length > 0;

    try {
      const guild = await getBotGuildSnapshot();

      if (adminMode) {
        const invokerRank = await getInvokerGuildRankByUsername(player, guild);
        if (!invokerRank || !isAllowedInvokerRank(invokerRank)) {
          return this.send(`You need one of these guild ranks: ${rankupConfig.allowedInvokerGuildRanks.join(", ")}`);
        }
      }

      if (!arg) {
        const result = await rankupSingle({ username: player, guild, triggerRoleSync: true });
        return this.send(formatSingleResult(result));
      }

      if (arg.toLowerCase() === "all") {
        const summary = await rankupAll({ guild, triggerRoleSync: true });
        return this.send(
          `Rankup all done | Checked: ${summary.checked} Updated: ${summary.updated} Unchanged: ${summary.unchanged} Protected: ${summary.skippedProtected} Failed: ${summary.failed}`
        );
      }

      const result = await rankupSingle({ username: arg, guild, triggerRoleSync: true });
      return this.send(formatSingleResult(result));
    } catch (error) {
      return this.send(error?.message || String(error));
    }
  }
}

module.exports = RankupCommand;
