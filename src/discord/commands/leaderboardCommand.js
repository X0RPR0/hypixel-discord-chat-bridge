const { SlashCommandBuilder } = require("discord.js");
const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const { SuccessEmbed } = require("../../contracts/embedHandler.js");
const leaderboardService = require("../other/leaderboardService.js");

const METRICS = ["score", "gexp", "chat_30d", "playtime_30d"];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show guild leaderboard preview or configure auto-updating leaderboard message.")
    .addStringOption((option) =>
      option
        .setName("metric")
        .setDescription("Leaderboard ranking metric")
        .addChoices(
          { name: "Activity Score", value: "score" },
          { name: "Guild XP", value: "gexp" },
          { name: "Chat 30d", value: "chat_30d" },
          { name: "Playtime 30d", value: "playtime_30d" }
        )
    )
    .addBooleanOption((option) => option.setName("setup").setDescription("Set this channel as the official auto-updating leaderboard location"))
    .addIntegerOption((option) => option.setName("top").setDescription("Number of members to display").setMinValue(1).setMaxValue(50)),
  moderatorOnly: true,
  requiresBot: true,

  execute: async (interaction) => {
    const selectedMetric = interaction.options.getString("metric") || undefined;
    const setup = interaction.options.getBoolean("setup") || false;
    const top = interaction.options.getInteger("top") || undefined;

    if (selectedMetric && !METRICS.includes(selectedMetric)) {
      throw new HypixelDiscordChatBridgeError("Invalid metric value.");
    }

    const { embed, metric, top: safeTop } = await leaderboardService.buildLeaderboard({
      metric: selectedMetric,
      top,
      persistSnapshot: setup
    });

    if (!setup) {
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (!interaction.channel || typeof interaction.channel.send !== "function") {
      throw new HypixelDiscordChatBridgeError("Cannot set up leaderboard in this channel.");
    }

    const leaderboardMessage = await interaction.channel.send({ embeds: [embed] });
    leaderboardService.setBinding({
      channelId: interaction.channel.id,
      messageId: leaderboardMessage.id,
      metric,
      top: safeTop
    });

    const success = new SuccessEmbed(
      `Leaderboard configured in <#${interaction.channel.id}> and will auto-update every 15 minutes.\nMetric: \`${metric}\` | Top: \`${safeTop}\``
    );
    await interaction.editReply({ embeds: [success] });
  }
};
