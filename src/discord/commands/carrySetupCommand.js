const { SlashCommandBuilder } = require("discord.js");
const { infoPayload } = require("../other/componentsV2Panels.js");

module.exports = {
  data: new SlashCommandBuilder().setName("carry-setup").setDescription("Open interactive Components V2 setup dashboard for carry/ticket system"),
  moderatorOnly: true,

  execute: async (interaction) => {
    const setupService = interaction.client.carrySetupService;
    if (!setupService) {
      return interaction.editReply(infoPayload({ title: "Carry Setup", status: "Error", lines: ["Carry setup service is unavailable."] }));
    }

    await setupService.show(interaction);
  }
};

