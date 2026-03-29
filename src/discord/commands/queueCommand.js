const { SlashCommandBuilder } = require("discord.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Manage carry queue")
    .addSubcommand((s) => s.setName("enable").setDescription("Enable queue"))
    .addSubcommand((s) => s.setName("disable").setDescription("Disable queue"))
    .addSubcommand((s) =>
      s
        .setName("priority")
        .setDescription("Set role queue priority")
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
        .addNumberOption((o) => o.setName("value").setDescription("Priority value").setRequired(true))
    )
    .addSubcommand((s) => s.setName("reset").setDescription("Reset queue and cancel queued carries"))
    .addSubcommand((s) => s.setName("repair").setDescription("Backfill missing carry channels/forum threads for active carries")),
  moderatorOnly: true,

  execute: async (interaction) => {
    const service = interaction.client.carryService;
    if (!service) {
      return interaction.editReply({ embeds: [new ErrorEmbed("Carry service unavailable.")] });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "enable") {
      service.setQueueEnabled(true);
      return interaction.editReply({ embeds: [new SuccessEmbed("Queue enabled.")] });
    }

    if (sub === "disable") {
      service.setQueueEnabled(false);
      return interaction.editReply({ embeds: [new SuccessEmbed("Queue disabled.")] });
    }

    if (sub === "priority") {
      const role = interaction.options.getRole("role", true);
      const value = interaction.options.getNumber("value", true);
      service.setRolePriority(role.id, value);
      return interaction.editReply({ embeds: [new SuccessEmbed(`Role <@&${role.id}> priority set to ${value}.`)] });
    }

    if (sub === "reset") {
      service.resetQueue();
      await service.publishCarrierDashboard();
      return interaction.editReply({ embeds: [new SuccessEmbed("Queue reset complete.")] });
    }

    if (sub === "repair") {
      const result = await service.reconcileMissingCarryArtifacts();
      await service.publishCarrierDashboard().catch(() => {});
      return interaction.editReply({
        embeds: [
          new SuccessEmbed(
            `Repair done. Checked: ${result.checked}, forum threads fixed: ${result.threadBackfilled}, execution channels fixed: ${result.channelBackfilled}, errors: ${result.errors}.`
          )
        ]
      });
    }

    return interaction.editReply({ embeds: [new ErrorEmbed("Unknown queue subcommand.")] });
  }
};
