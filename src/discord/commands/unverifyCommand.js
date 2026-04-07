const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");
const { getUsername } = require("../../contracts/API/mowojangAPI.js");
const { getUuidByDiscordId, removeLinkByDiscordId } = require("../../contracts/linkedStore.js");
const { MessageFlags, SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder().setName("unverify").setDescription("Remove your linked Minecraft account"),
  requiresBot: true,
  verificationCommand: true,

  execute: async (interaction) => {
    try {
      const uuid = getUuidByDiscordId(interaction.user.id);
      if (!uuid) {
        throw new HypixelDiscordChatBridgeError(`You are not verified. Please run /verify to continue.`);
      }

      if (!removeLinkByDiscordId(interaction.user.id)) {
        throw new HypixelDiscordChatBridgeError("Linked account database is unavailable. Please try again later.");
      }

      const updateRole = new SuccessEmbed(`You have successfully unlinked \`${await getUsername(uuid)}\`. Run \`/verify\` to link a new account.`, {
        text: `/help [command] for more information`
      });
      await interaction.followUp({ embeds: [updateRole] });
      const updateRolesCommand = require("./updateCommand.js");
      if (updateRolesCommand === undefined) {
        throw new HypixelDiscordChatBridgeError("The update command does not exist. Please contact an administrator.");
      }

      await updateRolesCommand.execute(interaction, undefined, true);
    } catch (error) {
      const errorEmbed = new ErrorEmbed(`\`\`\`${error}\`\`\``).setFooter({
        text: `/help [command] for more information`
      });

      await interaction.editReply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }
  }
};
