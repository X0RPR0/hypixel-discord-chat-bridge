const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");
const giveawayService = require("../other/giveawayService.js");

function parseRanks(input) {
  if (!input || typeof input !== "string") {
    return [];
  }

  return [
    ...new Set(
      input
        .split(",")
        .map((rank) => rank.trim())
        .filter((rank) => rank.length > 0)
    )
  ];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Start and configure giveaways")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Start a giveaway")
        .addStringOption((option) => option.setName("prize").setDescription("Giveaway prize").setRequired(true))
        .addStringOption((option) => option.setName("time").setDescription("Giveaway duration (e.g. 10m, 2h, 1d)").setRequired(true))
        .addIntegerOption((option) => option.setName("winners").setDescription("Number of winners").setMinValue(1))
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel to post the giveaway")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)
        )
        .addRoleOption((option) => option.setName("required_role").setDescription("Role required to join this giveaway"))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("allow")
        .setDescription("Configure who can start giveaways")
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Who can start giveaways")
            .addChoices({ name: "Everyone", value: "everyone" }, { name: "Bridge Admin Only", value: "bridge_admin_only" })
        )
        .addStringOption((option) => option.setName("ingame_ranks").setDescription("Comma separated in-game ranks allowed to start giveaways"))
        .addBooleanOption((option) => option.setName("clear_ranks").setDescription("Clear in-game rank allowlist"))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channel")
        .setDescription("Set or clear the default giveaway channel for in-game starts")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Default giveaway channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)
        )
        .addBooleanOption((option) => option.setName("clear").setDescription("Clear default giveaway channel"))
    ),
  guildOnly: true,

  execute: async (interaction) => {
    try {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "start") {
        const permission = giveawayService.canStartFromDiscord(interaction.member);
        if (!permission.ok) {
          return interaction.editReply({ embeds: [new ErrorEmbed(permission.reason)] });
        }

        const prize = interaction.options.getString("prize");
        const time = interaction.options.getString("time");
        const durationMs = giveawayService.parseDuration(time);
        if (!durationMs) {
          return interaction.editReply({ embeds: [new ErrorEmbed("Invalid duration. Examples: `10m`, `2h`, `1d`, `1h30m`")] });
        }

        const winners = interaction.options.getInteger("winners") || 1;
        const channel = interaction.options.getChannel("channel") || interaction.channel;
        const requiredRole = interaction.options.getRole("required_role");

        const giveaway = await giveawayService.createGiveaway({
          prize,
          durationMs,
          winnerCount: winners,
          channelId: channel?.id,
          requiredRoleId: requiredRole?.id || null,
          createdBy: {
            source: "discord",
            discordId: interaction.user.id
          }
        });

        const success = new SuccessEmbed(
          `Giveaway #${giveaway.id} started in <#${giveaway.channelId}>.\nPrize: **${giveaway.prize}**\nWinners: \`${giveaway.winnerCount}\``
        );
        return interaction.editReply({ embeds: [success] });
      }

      if (subcommand === "allow") {
        const roleIds = interaction.member?.roles?.cache?.map((role) => role.id) || [];
        const isAdmin = giveawayService.isBridgeAdmin({
          discordUserId: interaction.user.id,
          memberRoleIds: roleIds
        });
        if (!isAdmin) {
          return interaction.editReply({ embeds: [new ErrorEmbed("Only bridge admins can update giveaway permission settings.")] });
        }

        const current = giveawayService.getSettings();
        const mode = interaction.options.getString("mode") || current.starterMode;
        const clearRanks = interaction.options.getBoolean("clear_ranks") === true;
        const ranksInput = interaction.options.getString("ingame_ranks");
        let ranks = current.allowedIngameStarterRanks;
        if (clearRanks) {
          ranks = [];
        } else if (typeof ranksInput === "string") {
          ranks = parseRanks(ranksInput);
        }

        const updated = giveawayService.updateSettings({
          starterMode: mode,
          allowedIngameStarterRanks: ranks
        });

        const modeLabel = updated.starterMode === "bridge_admin_only" ? "Bridge Admin Only" : "Everyone";
        const ranksLabel = updated.allowedIngameStarterRanks.length > 0 ? updated.allowedIngameStarterRanks.join(", ") : "Everyone";
        const success = new SuccessEmbed(`Updated giveaway settings.\nStarter mode: \`${modeLabel}\`\nIn-game starter ranks: \`${ranksLabel}\``);
        return interaction.editReply({ embeds: [success] });
      }

      if (subcommand === "channel") {
        const roleIds = interaction.member?.roles?.cache?.map((role) => role.id) || [];
        const isAdmin = giveawayService.isBridgeAdmin({
          discordUserId: interaction.user.id,
          memberRoleIds: roleIds
        });
        if (!isAdmin) {
          return interaction.editReply({ embeds: [new ErrorEmbed("Only bridge admins can update giveaway channel settings.")] });
        }

        const clear = interaction.options.getBoolean("clear") === true;
        const channel = interaction.options.getChannel("channel");
        const updated = giveawayService.updateSettings({
          defaultChannelId: clear ? null : channel?.id
        });

        const value = updated.defaultChannelId ? `<#${updated.defaultChannelId}>` : "`Not set`";
        const success = new SuccessEmbed(`Default in-game giveaway channel updated: ${value}`);
        return interaction.editReply({ embeds: [success] });
      }

      return interaction.editReply({ embeds: [new ErrorEmbed("Invalid giveaway subcommand.")] });
    } catch (error) {
      console.error(error);
      return interaction.editReply({ embeds: [new ErrorEmbed(`\`\`\`${error}\`\`\``)] });
    }
  }
};
