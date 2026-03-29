const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");
const ms = require("ms");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup carry/ticket dashboards and channels")
    .addSubcommand((s) =>
      s
        .setName("carry-dashboard")
        .setDescription("Set carry request dashboard channel")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("carrier-dashboard")
        .setDescription("Set carrier dashboard channel")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("carrier-stats")
        .setDescription("Set carrier stats dashboard channel")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("ticket-dashboard")
        .setDescription("Set ticket dashboard channel")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("ticket-logs")
        .setDescription("Set ticket forum logs channel")
        .addChannelOption((o) => o.setName("forum_channel").setDescription("Forum channel").setRequired(true).addChannelTypes(ChannelType.GuildForum))
    )
    .addSubcommand((s) =>
      s
        .setName("ticket-logs-id")
        .setDescription("Set ticket forum logs channel by ID")
        .addStringOption((o) => o.setName("forum_id").setDescription("Forum channel ID").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("carry-category")
        .setDescription("Set carry execution category")
        .addChannelOption((o) => o.setName("category").setDescription("Category").setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    )
    .addSubcommand((s) =>
      s
        .setName("carry-autodelete")
        .setDescription("Set carry channel autodelete delay")
        .addStringOption((o) => o.setName("time").setDescription("e.g. 30m, 2h").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("carry-transcript")
        .setDescription("Enable/disable carry transcript logging")
        .addBooleanOption((o) => o.setName("enabled").setDescription("Enabled").setRequired(true))
    ),
  moderatorOnly: true,

  execute: async (interaction) => {
    const carryService = interaction.client.carryService;
    const ticketService = interaction.client.ticketService;
    if (!carryService || !ticketService) {
      return interaction.editReply({ embeds: [new ErrorEmbed("Carry/Ticket services are not initialized.")] });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "carry-dashboard") {
      const channel = interaction.options.getChannel("channel", true);
      carryService.setCarryDashboardChannelId(channel.id);
      await carryService.publishCarryDashboard(channel.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Carry dashboard set to <#${channel.id}>.`)] });
    }

    if (sub === "carrier-dashboard") {
      const channel = interaction.options.getChannel("channel", true);
      carryService.setCarrierDashboardChannelId(channel.id);
      await carryService.publishCarrierDashboard(channel.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Carrier dashboard set to <#${channel.id}>.`)] });
    }

    if (sub === "carrier-stats") {
      const channel = interaction.options.getChannel("channel", true);
      carryService.setCarrierStatsChannelId(channel.id);
      await carryService.publishCarrierStatsDashboard(channel.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Carrier stats dashboard set to <#${channel.id}>.`)] });
    }

    if (sub === "ticket-dashboard") {
      const channel = interaction.options.getChannel("channel", true);
      ticketService.setTicketDashboardChannelId(channel.id);
      await ticketService.publishDashboard(channel.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Ticket dashboard set to <#${channel.id}>.`)] });
    }

    if (sub === "ticket-logs") {
      const forum = interaction.options.getChannel("forum_channel", true);
      ticketService.setTicketLogsForumId(forum.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Ticket logs forum set to <#${forum.id}>.`)] });
    }

    if (sub === "ticket-logs-id") {
      const input = interaction.options.getString("forum_id", true).trim();
      const forumId = input.replace(/[<#>]/g, "");
      const forum = await interaction.client.channels.fetch(forumId).catch(() => null);
      if (!forum || forum.type !== ChannelType.GuildForum) {
        return interaction.editReply({ embeds: [new ErrorEmbed("Invalid forum channel ID. The channel must be a forum.")] });
      }

      ticketService.setTicketLogsForumId(forum.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Ticket logs forum set to <#${forum.id}>.`)] });
    }

    if (sub === "carry-category") {
      const category = interaction.options.getChannel("category", true);
      carryService.setCarryCategoryId(category.id);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Carry category set to **${category.name}**.`)] });
    }

    if (sub === "carry-autodelete") {
      const time = interaction.options.getString("time", true);
      const parsed = ms(time);
      if (!parsed || parsed <= 0) {
        return interaction.editReply({ embeds: [new ErrorEmbed("Invalid duration. Example: `30m`, `2h`." )] });
      }
      carryService.setCarryAutoDelete(parsed);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Carry autodelete set to **${time}**.`)] });
    }

    if (sub === "carry-transcript") {
      const enabled = interaction.options.getBoolean("enabled", true);
      carryService.setCarryTranscriptEnabled(enabled);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Carry transcript logging ${enabled ? "enabled" : "disabled"}.`)] });
    }

    return interaction.editReply({ embeds: [new ErrorEmbed("Unknown setup subcommand.")] });
  }
};
