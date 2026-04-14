const app = require("./../../Application.js");
const { Embed } = require("../../contracts/embedHandler.js");
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder().setName("restart").setDescription("Restarts the bot."),
  moderatorOnly: true,

  execute: async (interaction) => {
    const restartEmbed = new Embed().setTitle("Restarting...").setDescription("The bot is restarting. This might take few seconds.");
    await interaction.followUp({ embeds: [restartEmbed] });

    try {
      if (app?.minecraft?.bot) {
        await app.minecraft.bot.end("restart");
      } else if (global.bot) {
        await global.bot.end("restart");
      }
    } catch (error) {
      console.error("Failed to close Minecraft bot during restart:", error);
    }

    try {
      if (app?.discord?.client) {
        await app.discord.client.destroy();
      } else if (global.client) {
        await global.client.destroy();
      }
    } catch (error) {
      console.error("Failed to close Discord client during restart:", error);
    }

    // In container/managed runtime we should terminate the process so orchestration can restart cleanly.
    setTimeout(() => process.exit(0), 200);
  }
};
