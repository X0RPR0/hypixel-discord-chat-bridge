const { SlashCommandBuilder } = require("discord.js");
const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const {
  getRankupConfig,
  getBotGuildSnapshot,
  getInvokerGuildRankByDiscordId,
  isAllowedInvokerRank,
  rankupSingle,
  rankupSingleByUuid,
  rankupAll,
  readLinkedData
} = require("../../contracts/rankupService.js");
const { isGuildMember, isVerifiedMember } = require("../../contracts/verificaiton.js");

function formatSingleResult(result) {
  if (result.status === "updated") {
    const roleSyncSuffix =
      result.roleSync?.status === "skipped"
        ? " | Discord role sync skipped (no linked user)."
        : result.roleSync?.status === "failed"
          ? ` | Discord role sync failed: ${result.roleSync.reason}`
          : "";

    return `Updated \`${result.username}\`: \`${result.currentGuildRank}\` -> \`${result.targetGuildRank}\` (SB Level ${result.skyblockLevel}).${roleSyncSuffix}`;
  }

  if (result.status === "unchanged") {
    return `No changes for \`${result.username}\`: already \`${result.targetGuildRank}\` (SB Level ${result.skyblockLevel}).`;
  }

  if (result.status === "skipped_protected") {
    return `\`${result.username}\` already has a higher/protected rank (\`${result.currentGuildRank}\`) - silly goose, no derank today.`;
  }

  return `Failed for \`${result.username}\`: ${result.reason}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("rankup")
    .setDescription("Sync guild rank from SkyBlock level thresholds")
    .addStringOption((option) => option.setName("user").setDescription("Target Minecraft username"))
    .addBooleanOption((option) => option.setName("all").setDescription("Sync all guild members")),
  requiresBot: true,

  execute: async (interaction) => {
    const rankupConfig = getRankupConfig();
    if (!rankupConfig.enabled || !rankupConfig.manual.discordEnabled) {
      throw new HypixelDiscordChatBridgeError("Rankup is disabled.");
    }

    const user = interaction.options.getString("user");
    const all = interaction.options.getBoolean("all") === true;
    if (user && all) {
      throw new HypixelDiscordChatBridgeError("You cannot specify both `user` and `all`.");
    }

    const adminMode = Boolean(user || all);
    const guild = await getBotGuildSnapshot();

    if (adminMode) {
      const invokerRank = await getInvokerGuildRankByDiscordId(interaction.user.id, guild);
      if (!isAllowedInvokerRank(invokerRank)) {
        throw new HypixelDiscordChatBridgeError(`You need one of these guild ranks: ${rankupConfig.allowedInvokerGuildRanks.join(", ")}.`);
      }

      if (all) {
        const summary = await rankupAll({ guild, triggerRoleSync: true });
        const header = `Rankup all complete. Checked: ${summary.checked}, Updated: ${summary.updated}, Unchanged: ${summary.unchanged}, Protected: ${summary.skippedProtected}, Failed: ${summary.failed}.`;
        const failures = summary.results.filter((result) => result.status === "failed").slice(0, 5);
        const failureText = failures.length > 0 ? `\nFailures: ${failures.map((result) => `${result.username} (${result.reason})`).join(", ")}` : "";
        await interaction.followUp({ content: `${header}${failureText}` });
        return;
      }

      const result = await rankupSingle({ username: user, guild, triggerRoleSync: true });
      await interaction.followUp({ content: formatSingleResult(result) });
      return;
    }

    if (!isVerifiedMember(interaction)) {
      throw new HypixelDiscordChatBridgeError("You need to be verified to use this command.");
    }
    if (!isGuildMember(interaction)) {
      throw new HypixelDiscordChatBridgeError("You need to be a guild member to use this command.");
    }

    const linked = readLinkedData();
    const uuid = Object.entries(linked).find(([, value]) => value === interaction.user.id)?.[0];
    if (!uuid) {
      throw new HypixelDiscordChatBridgeError("You are not linked to a Minecraft account.");
    }

    const result = await rankupSingleByUuid({ uuid, guild, triggerRoleSync: true });
    await interaction.followUp({ content: formatSingleResult(result) });
  }
};
