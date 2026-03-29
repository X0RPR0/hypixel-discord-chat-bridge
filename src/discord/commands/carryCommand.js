const { SlashCommandBuilder } = require("discord.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("carry")
    .setDescription("Manage carry catalog and pricing")
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("Add carry type with tiers")
        .addStringOption((o) => o.setName("name").setDescription("Carry type key").setRequired(true))
        .addStringOption((o) => o.setName("tiers").setDescription("Comma separated tiers").setRequired(true))
    )
    .addSubcommand((s) => s.setName("remove").setDescription("Remove carry type").addStringOption((o) => o.setName("name").setRequired(true).setDescription("Carry type")))
    .addSubcommand((s) =>
      s
        .setName("price")
        .setDescription("Set carry tier price")
        .addStringOption((o) => o.setName("type").setDescription("Carry type").setRequired(true))
        .addStringOption((o) => o.setName("tier").setDescription("Tier").setRequired(true))
        .addNumberOption((o) => o.setName("price").setDescription("Price per unit").setRequired(true).setMinValue(0))
    )
    .addSubcommand((s) => s.setName("enable").setDescription("Enable carry type").addStringOption((o) => o.setName("type").setDescription("Type").setRequired(true)))
    .addSubcommand((s) => s.setName("disable").setDescription("Disable carry type").addStringOption((o) => o.setName("type").setDescription("Type").setRequired(true))),
  moderatorOnly: true,

  execute: async (interaction) => {
    const service = interaction.client.carryService;
    if (!service) {
      return interaction.editReply({ embeds: [new ErrorEmbed("Carry service unavailable.")] });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "add") {
      const name = interaction.options.getString("name", true);
      const tiers = interaction.options.getString("tiers", true);
      const count = service.addCarryTypeWithTiers(name, tiers);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Added/updated ${count} tier(s) for **${name}**.`)] });
    }

    if (sub === "remove") {
      const name = interaction.options.getString("name", true);
      const changes = service.removeCarryType(name);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Removed ${changes} carry tier entries for **${name}**.`)] });
    }

    if (sub === "price") {
      const type = interaction.options.getString("type", true);
      const tier = interaction.options.getString("tier", true);
      const price = interaction.options.getNumber("price", true);
      const updated = service.setCarryPrice(type, tier, price);
      if (!updated) return interaction.editReply({ embeds: [new ErrorEmbed("Carry type/tier not found.")] });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Set **${type} ${tier}** price to ${price}.`)] });
    }

    if (sub === "enable") {
      const type = interaction.options.getString("type", true);
      const changes = service.setCarryEnabled(type, true);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Enabled ${changes} entries for **${type}**.`)] });
    }

    if (sub === "disable") {
      const type = interaction.options.getString("type", true);
      const changes = service.setCarryEnabled(type, false);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Disabled ${changes} entries for **${type}**.`)] });
    }

    return interaction.editReply({ embeds: [new ErrorEmbed("Unknown carry subcommand.")] });
  }
};
