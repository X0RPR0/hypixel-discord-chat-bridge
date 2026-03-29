const { SlashCommandBuilder } = require("discord.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");
const ms = require("ms");

function parseDuration(input) {
  const parsed = ms(input);
  return parsed && parsed > 0 ? parsed : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("discount")
    .setDescription("Manage discounts")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Set static global discount threshold")
        .addIntegerOption((o) => o.setName("amount").setDescription("Minimum amount").setRequired(true).setMinValue(1))
        .addNumberOption((o) => o.setName("percentage").setDescription("Discount percentage").setRequired(true).setMinValue(0).setMaxValue(95))
    )
    .addSubcommand((s) => s.setName("remove").setDescription("Remove static global discount").addIntegerOption((o) => o.setName("amount").setRequired(true).setDescription("Minimum amount")))
    .addSubcommand((s) =>
      s
        .setName("timed-global")
        .setDescription("Timed global discount")
        .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
        .addStringOption((o) => o.setName("duration").setRequired(true).setDescription("e.g. 3h, 2d"))
    )
    .addSubcommand((s) =>
      s
        .setName("timed-carry")
        .setDescription("Timed carry-type discount")
        .addStringOption((o) => o.setName("type").setRequired(true).setDescription("Carry type"))
        .addStringOption((o) => o.setName("tier").setDescription("Optional tier"))
        .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
        .addStringOption((o) => o.setName("duration").setRequired(true).setDescription("e.g. 3h, 2d"))
    )
    .addSubcommand((s) =>
      s
        .setName("timed-category")
        .setDescription("Timed category discount")
        .addStringOption((o) => o.setName("category").setRequired(true).setDescription("Category"))
        .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
        .addStringOption((o) => o.setName("duration").setRequired(true).setDescription("e.g. 3h, 2d"))
    )
    .addSubcommand((s) =>
      s
        .setName("bulk-category")
        .setDescription("Bulk category discount")
        .addStringOption((o) => o.setName("category").setRequired(true).setDescription("Category"))
        .addIntegerOption((o) => o.setName("amount").setRequired(true).setDescription("Min amount").setMinValue(1))
        .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
    )
    .addSubcommand((s) =>
      s
        .setName("bulk-carry")
        .setDescription("Bulk carry discount")
        .addStringOption((o) => o.setName("type").setRequired(true).setDescription("Carry type"))
        .addStringOption((o) => o.setName("tier").setRequired(true).setDescription("Tier"))
        .addIntegerOption((o) => o.setName("amount").setRequired(true).setDescription("Min amount").setMinValue(1))
        .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
    )
    .addSubcommand((s) => s.setName("stacking").setDescription("Set stacking mode (policy constrained)").addBooleanOption((o) => o.setName("enabled").setRequired(true).setDescription("Enabled"))),
  moderatorOnly: true,

  execute: async (interaction) => {
    const service = interaction.client.carryService;
    if (!service) {
      return interaction.editReply({ embeds: [new ErrorEmbed("Carry service unavailable.")] });
    }

    const sub = interaction.options.getSubcommand();
    const now = Date.now();

    if (sub === "set") {
      const amount = interaction.options.getInteger("amount", true);
      const percentage = interaction.options.getNumber("percentage", true);
      const id = service.addDiscountRule({ kind: "static", scope: "global", minAmount: amount, percentage });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Static discount rule #${id} created for amount >= ${amount}.`)] });
    }

    if (sub === "remove") {
      const amount = interaction.options.getInteger("amount", true);
      const changes = service.removeStaticDiscountByAmount(amount);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Removed ${changes} static discount rule(s) for amount >= ${amount}.`)] });
    }

    if (sub === "timed-global") {
      const percentage = interaction.options.getNumber("percentage", true);
      const duration = interaction.options.getString("duration", true);
      const durationMs = parseDuration(duration);
      if (!durationMs) return interaction.editReply({ embeds: [new ErrorEmbed("Invalid duration.")] });
      const id = service.addDiscountRule({ kind: "timed", scope: "global", percentage, startsAt: now, endsAt: now + durationMs });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Timed global discount #${id} created.`)] });
    }

    if (sub === "timed-carry") {
      const type = interaction.options.getString("type", true).toLowerCase();
      const tier = interaction.options.getString("tier")?.toLowerCase() || null;
      const percentage = interaction.options.getNumber("percentage", true);
      const duration = interaction.options.getString("duration", true);
      const durationMs = parseDuration(duration);
      if (!durationMs) return interaction.editReply({ embeds: [new ErrorEmbed("Invalid duration.")] });
      const id = service.addDiscountRule({ kind: "timed", scope: "carry", carryType: type, tier, percentage, startsAt: now, endsAt: now + durationMs });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Timed carry discount #${id} created.`)] });
    }

    if (sub === "timed-category") {
      const category = interaction.options.getString("category", true).toLowerCase();
      const percentage = interaction.options.getNumber("percentage", true);
      const duration = interaction.options.getString("duration", true);
      const durationMs = parseDuration(duration);
      if (!durationMs) return interaction.editReply({ embeds: [new ErrorEmbed("Invalid duration.")] });
      const id = service.addDiscountRule({ kind: "timed", scope: "category", category, percentage, startsAt: now, endsAt: now + durationMs });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Timed category discount #${id} created.`)] });
    }

    if (sub === "bulk-category") {
      const category = interaction.options.getString("category", true).toLowerCase();
      const amount = interaction.options.getInteger("amount", true);
      const percentage = interaction.options.getNumber("percentage", true);
      const id = service.addDiscountRule({ kind: "bulk", scope: "category", category, minAmount: amount, percentage });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Bulk category discount #${id} created.`)] });
    }

    if (sub === "bulk-carry") {
      const type = interaction.options.getString("type", true).toLowerCase();
      const tier = interaction.options.getString("tier", true).toLowerCase();
      const amount = interaction.options.getInteger("amount", true);
      const percentage = interaction.options.getNumber("percentage", true);
      const id = service.addDiscountRule({ kind: "bulk", scope: "carry", carryType: type, tier, minAmount: amount, percentage });
      return interaction.editReply({ embeds: [new SuccessEmbed(`Bulk carry discount #${id} created.`)] });
    }

    if (sub === "stacking") {
      const enabled = interaction.options.getBoolean("enabled", true);
      service.db.setBinding("discount_stacking_enabled", enabled);
      return interaction.editReply({
        embeds: [new SuccessEmbed(`Stacking ${enabled ? "enabled" : "disabled"}. Policy still enforces only bulk + one scope discount and no multi-scope stacking.`)]
      });
    }

    return interaction.editReply({ embeds: [new ErrorEmbed("Unknown discount subcommand.")] });
  }
};
