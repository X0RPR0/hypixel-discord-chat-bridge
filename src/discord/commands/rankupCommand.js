const { SlashCommandBuilder } = require("discord.js");
const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const {
  getRankupConfig,
  getBotGuildSnapshot,
  getInvokerGuildRankByDiscordId,
  isAllowedInvokerRank,
  rankupSingle,
  rankupSingleByUuid,
  rankupAll
} = require("../../contracts/rankupService.js");
const { Embed, SuccessEmbed } = require("../../contracts/embedHandler.js");
const { getUuidByDiscordId } = require("../../contracts/linkedStore.js");
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

function getActionLabel(result) {
  if (result?.status === "updated") {
    return `updated \`${result.currentGuildRank}\` -> \`${result.targetGuildRank}\``;
  }

  if (result?.status === "unchanged") {
    return `unchanged (\`${result.targetGuildRank}\`)`;
  }

  if (result?.status === "skipped_protected") {
    return `skipped protected (\`${result.currentGuildRank}\`)`;
  }

  return `failed (${result?.reason || "Unknown error"})`;
}

function buildProgressBar(done, total, width = 24) {
  if (total <= 0) {
    return `[${"-".repeat(width)}] 0%`;
  }

  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  const percentage = Math.round(ratio * 100);
  return `[${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}] ${percentage}%`;
}

function formatStatusSummary(summary) {
  return `Updated: \`${summary.updated}\` | Unchanged: \`${summary.unchanged}\` | Protected: \`${summary.skippedProtected}\` | Failed: \`${summary.failed}\``;
}

function formatUserList(results, status, limit = 15) {
  const users = results.filter((result) => result.status === status).map((result) => result.username);
  if (users.length === 0) {
    return "None";
  }

  const sliced = users
    .slice(0, limit)
    .map((user) => `\`${user}\``)
    .join(", ");
  if (users.length > limit) {
    return `${sliced} +${users.length - limit} more`;
  }

  return sliced;
}

function truncateText(value, max = 1000) {
  if (!value || value.length <= max) {
    return value || "None";
  }

  return `${value.slice(0, Math.max(0, max - 3))}...`;
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
        const total = guild.members.length;
        const startedAt = Date.now();
        const invokedBy = `<@${interaction.user.id}>`;
        const recentActions = [];
        let lastProgressEdit = 0;

        const updateProgressEmbed = async ({ done, total, username, result, summary, force = false }) => {
          const now = Date.now();
          if (!force && done < total && now - lastProgressEdit < 1200) {
            return;
          }

          lastProgressEdit = now;
          recentActions.push(truncateText(`• \`${username}\` -> ${getActionLabel(result)}`, 180));
          const recentSlice = truncateText(recentActions.slice(-8).join("\n"));
          const progressEmbed = new Embed()
            .setAuthor({ name: "Rankup All In Progress" })
            .setDescription(`Running guild rank sync triggered by ${invokedBy}.`)
            .addFields(
              { name: "Current Member", value: `\`${username}\``, inline: true },
              { name: "Done", value: `\`${done}/${total}\``, inline: true },
              { name: "Progress", value: `\`${buildProgressBar(done, total)}\``, inline: false },
              { name: "Summary So Far", value: formatStatusSummary(summary), inline: false },
              { name: "Recent Actions", value: recentSlice || "No actions yet.", inline: false }
            );

          await interaction.editReply({ embeds: [progressEmbed] });
        };

        await interaction.editReply({
          embeds: [
            new Embed()
              .setAuthor({ name: "Rankup All Starting" })
              .setDescription(`Preparing guild sync for \`${total}\` members.\nRequested by ${invokedBy}.`)
              .addFields({ name: "Progress", value: `\`${buildProgressBar(0, total)}\`` })
          ]
        });

        const summary = await rankupAll({
          guild,
          triggerRoleSync: true,
          onProgress: async (progress) => updateProgressEmbed(progress)
        });

        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const failedUsers = truncateText(
          summary.results
            .filter((result) => result.status === "failed")
            .slice(0, 8)
            .map((result) => `\`${result.username}\` (${result.reason})`)
            .join("\n")
        );

        const finalEmbed = new SuccessEmbed("Rankup all complete.")
          .setAuthor({ name: "Rankup All Complete" })
          .setDescription(`Finished guild rank sync in \`${elapsedSeconds}s\`.\nRequested by ${invokedBy}.`)
          .addFields(
            { name: "Total Checked", value: `\`${summary.checked}\``, inline: true },
            { name: "Progress", value: `\`${buildProgressBar(summary.checked, summary.checked)}\``, inline: true },
            { name: "Summary", value: formatStatusSummary(summary), inline: false },
            { name: "Updated Users", value: formatUserList(summary.results, "updated"), inline: false },
            { name: "Unchanged Users", value: formatUserList(summary.results, "unchanged"), inline: false },
            { name: "Protected Users", value: formatUserList(summary.results, "skipped_protected"), inline: false }
          );

        if (failedUsers) {
          finalEmbed.addFields({ name: "Failures", value: failedUsers, inline: false });
        }

        await interaction.editReply({ embeds: [finalEmbed] });
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

    const uuid = getUuidByDiscordId(interaction.user.id);
    if (!uuid) {
      throw new HypixelDiscordChatBridgeError("You are not linked to a Minecraft account.");
    }

    const result = await rankupSingleByUuid({ uuid, guild, triggerRoleSync: true });
    await interaction.followUp({ content: formatSingleResult(result) });
  }
};
