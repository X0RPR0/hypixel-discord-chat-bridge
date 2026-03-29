const { SlashCommandBuilder } = require("discord.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("freecarry")
    .setDescription("Manage free carry policy")
    .addSubcommand((s) => s.setName("reset-weekly").setDescription("Trigger weekly free carry reset log event"))
    .addSubcommand((s) =>
      s
        .setName("set-limit")
        .setDescription("Set free carries per week per user")
        .addIntegerOption((o) => o.setName("amount").setDescription("Limit").setRequired(true).setMinValue(0).setMaxValue(100))
    )
    .addSubcommand((s) =>
      s
        .setName("grant")
        .setDescription("Grant additional free carry credits to a user")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Additional credits").setRequired(true).setMinValue(1).setMaxValue(100))
    ),
  moderatorOnly: true,

  execute: async (interaction) => {
    const service = interaction.client.carryService;
    if (!service) {
      return interaction.editReply({ embeds: [new ErrorEmbed("Carry service unavailable.")] });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "reset-weekly") {
      service.resetFreeCarryWeekly();
      return interaction.editReply({ embeds: [new SuccessEmbed("Weekly reset marker recorded.")] });
    }

    if (sub === "set-limit") {
      const amount = interaction.options.getInteger("amount", true);
      service.setFreeCarryLimit(amount);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Free carry weekly limit set to ${amount}.`)] });
    }

    if (sub === "grant") {
      const user = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      const result = service.grantFreeCarryBonus(user.id, amount);
      if (!result.ok) {
        return interaction.editReply({ embeds: [new ErrorEmbed(result.reason)] });
      }

      return interaction.editReply({ embeds: [new SuccessEmbed(`Granted ${amount} bonus free carry credit(s) to <@${user.id}>. Remaining bonus: ${result.remaining}.`)] });
    }

    return interaction.editReply({ embeds: [new ErrorEmbed("Unknown freecarry subcommand.")] });
  }
};
