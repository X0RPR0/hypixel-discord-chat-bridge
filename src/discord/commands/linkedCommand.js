const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const { getUUID, getUsername } = require("../../contracts/API/mowojangAPI.js");
const { SuccessEmbed, ErrorEmbed } = require("../../contracts/embedHandler.js");
const { getDiscordIdByUuid, getUuidByDiscordId } = require("../../contracts/linkedStore.js");
const { MessageFlags, SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("linked")
    .setDescription("View who a user is linked to")
    .addUserOption((option) => option.setName("user").setDescription("Discord Username"))
    .addStringOption((option) => option.setName("username").setDescription("Minecraft Username")),
  moderatorOnly: true,
  verificationCommand: true,

  execute: async (interaction) => {
    try {
      const user = interaction.options.getUser("user");
      const name = interaction.options.getString("username");
      if (!user && !name) {
        throw new HypixelDiscordChatBridgeError("Please provide a user or a name.");
      }

      if (user && !name) {
        const uuid = getUuidByDiscordId(user.id);
        if (!uuid) {
          throw new HypixelDiscordChatBridgeError("This user is not linked.");
        }

        const username = await getUsername(uuid);
        const embed = new SuccessEmbed(`<@${user.id}> is linked to \`${username}\` (\`${uuid}\`).`, {
          text: `/help [command] for more information`
        });
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else if (!user && name) {
        const uuid = await getUUID(name);
        if (uuid === undefined) {
          throw new HypixelDiscordChatBridgeError("This user does not exist.");
        }

        const discordID = getDiscordIdByUuid(uuid);
        if (!discordID) {
          throw new HypixelDiscordChatBridgeError("This user is not linked.");
        }

        const embed = new SuccessEmbed(`\`${name}\` (\`${uuid}\`) is linked to <@${discordID}>.`, {
          text: `/help [command] for more information`
        });

        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        throw new HypixelDiscordChatBridgeError("Please provide a user or a name, not both.");
      }
    } catch (error) {
      const msg = String(error?.message || error || "Unknown error");
      const safe = msg.includes("Unexpected end of JSON input") ? "Mojang lookup temporarily failed. Try again." : msg;
      const errorEmbed = new ErrorEmbed(`\`\`\`${safe}\`\`\``).setFooter({
        text: `/help [command] for more information`
      });

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
};
