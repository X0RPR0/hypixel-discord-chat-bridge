const { SlashCommandBuilder } = require("discord.js");
const { infoPayload } = require("../other/componentsV2Panels.js");

module.exports = {
  data: new SlashCommandBuilder().setName("carry-admin").setDescription("Open ephemeral Service-Admin carry control panel"),
  ephemeral: true,

  execute: async (interaction) => {
    const carryService = interaction.client.carryService;
    if (!carryService) {
      await interaction.editReply(infoPayload({ title: "Carry Admin", lines: ["Carry service unavailable."], ephemeral: true }));
      return;
    }

    if (!carryService.isAdmin(interaction.member)) {
      await interaction.editReply(infoPayload({ title: "Carry Admin", lines: ["Only Service-Admin can use this command."], ephemeral: true }));
      return;
    }

    const messageId = interaction.id || "0";
    const actorId = interaction.user?.id || "0";
    const payload = carryService.buildCarryAdminPanel({ messageId, actorId });
    await interaction.editReply(payload);
  }
};
