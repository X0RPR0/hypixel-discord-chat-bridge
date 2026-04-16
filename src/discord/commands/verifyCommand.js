const { Embed, ErrorEmbed, SuccessEmbed } = require("../../contracts/embedHandler.js");
const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const hypixelRebornAPI = require("../../contracts/API/HypixelRebornAPI.js");
const { formatError } = require("../../contracts/helperFunctions.js");
const { upsertLink } = require("../../contracts/linkedStore.js");
const updateRolesCommand = require("./updateCommand.js");
const config = require('../../config');
const { MessageFlags, SlashCommandBuilder } = require("discord.js");

function isLikelyHypixelApiIssue(errorMessage) {
  const message = String(errorMessage || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("request to hypixel api failed") ||
    message.includes("invalid api key") ||
    message.includes("api key") ||
    message.includes("forbidden") ||
    message.includes("status code 403") ||
    message.includes("key is invalid") ||
    message.includes("missing api")
  );
}

async function verifyWithUsername(interaction, username, extra = {}) {
  const linkedRole = guild.roles.cache.get(config.verification.roles.verified.roleId);
  if (!linkedRole) {
    throw new HypixelDiscordChatBridgeError("The verified role does not exist. Please contact an administrator.");
  }

  const { socialMedia, nickname, uuid } = await hypixelRebornAPI.getPlayer(username);

  const discordUsername = socialMedia.find((media) => media.id === "DISCORD")?.link;
  if (!discordUsername) {
    throw new HypixelDiscordChatBridgeError(`The player '${nickname}' has not linked their Discord account. Please follow the instructions below.`);
  }

  if (discordUsername.toLowerCase() !== interaction.user.username.toLowerCase()) {
    throw new HypixelDiscordChatBridgeError(
      `The player '${nickname}' has linked their Discord account to a different account ('${discordUsername}'). Please follow the instructions below.`
    );
  }

  if (!upsertLink(uuid, interaction.user.id)) {
    throw new HypixelDiscordChatBridgeError("Linked account database is unavailable. Please try again later.");
  }

  const embed = new SuccessEmbed(`${extra.user ? `<@${extra.user.id}>'s` : "Your"} account has been successfully linked to \`${nickname}\``)
    .setAuthor({ name: "Successfully linked!" })
    .setFooter({
      text: `/help [command] for more information`
    });

  await interaction.editReply({ embeds: [embed], flags: MessageFlags.Ephemeral });

  await updateRolesCommand.execute(interaction);
}

async function runVerification(interaction, username, extra = {}) {
  try {
    await verifyWithUsername(interaction, username, extra);
  } catch (error) {
    console.error(error);
    // eslint-disable-next-line no-ex-assign
    error = formatError(error);

    const errorEmbed = new ErrorEmbed(`\`\`\`${error}\`\`\``).setFooter({
      text: `/help [command] for more information`
    });

    await interaction.editReply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    if (isLikelyHypixelApiIssue(error)) {
      const manualRequest = await interaction.client.manualLinkRequestService
        .createReviewRequest({
          requesterDiscordId: interaction.user.id,
          requesterTag: interaction.user.tag,
          claimedUsername: username,
          reason: "Hypixel API unavailable during /verify"
        })
        .catch(() => null);

      const followUpText = manualRequest
        ? `Hypixel API verification is unavailable. Staff review request created: \`${manualRequest.requestId}\`.`
        : "Hypixel API verification is unavailable and I could not create a staff review request.";
      await interaction.followUp({
        content: followUpText,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (error.includes("Please follow the instructions below.")) {
      const verificationTutorialEmbed = new Embed()
        .setAuthor({ name: "Link with Hypixel Social Media" })
        .setDescription(
          `**Instructions:**\n1) Use your Minecraft client to connect to Hypixel.\n2) Once connected, and while in the lobby, right click "My Profile" in your hotbar. It is option #2.\n3) Click "Social Media" - this button is to the left of the Redstone block (the Status button).\n4) Click "Discord" - it is the second last option.\n5) Paste your Discord username into chat and hit enter. For reference: \`${interaction.user.username ?? interaction.user.tag}\`\n6) You're done! Wait around 30 seconds and then try again.\n\n**Getting "The URL isn't valid!"?**\nHypixel has limitations on the characters supported in a Discord username. Try changing your Discord username temporarily to something without special characters, updating it in-game, and trying again.`
        )
        .setImage("https://media.discordapp.net/attachments/922202066653417512/1066476136953036800/tutorial.gif")
        .setFooter({
          text: `/help [command] for more information`
        });

      await interaction.followUp({ embeds: [verificationTutorialEmbed], flags: MessageFlags.Ephemeral });
    }
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Connect your Discord account to Minecraft")
    .addStringOption((option) => option.setName("username").setDescription("Minecraft Username").setRequired(true)),
  verificationCommand: true,
  requiresBot: true,

  execute: async (interaction, extra = {}) => {
    const username = interaction.options.getString("username");
    await runVerification(interaction, username, extra);
  },
  verifyWithUsername,
  runVerification
};
