const { isLinkedMember, isGuildMember, isVerifiedMember } = require("../../contracts/verificaiton.js");
const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const { ErrorEmbed, SuccessEmbed } = require("../../contracts/embedHandler.js");
const { JoinRequestManager, PANEL_BUTTON_ID, PANEL_VERIFY_BUTTON_ID, PANEL_MODAL_ID, PANEL_VERIFY_MODAL_ID } = require("../other/joinRequestManager.js");
const giveawayService = require("../other/giveawayService.js");
// eslint-disable-next-line no-unused-vars
const { CommandInteraction, Events } = require("discord.js");
const config = require("../../../config.json");

module.exports = {
  name: Events.InteractionCreate,
  /**
   * @param {CommandInteraction} interaction
   */
  async execute(interaction) {
    try {
      if (interaction.isAutocomplete()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (!command || typeof command.autocomplete !== "function") {
          return interaction.respond([]).catch(() => {});
        }

        return command.autocomplete(interaction);
      }

      if (interaction.isChatInputCommand()) {
        const memberRoles = interaction.member.roles.cache.map((role) => role.id);
        const command = interaction.client.commands.get(interaction.commandName);
        if (command === undefined) {
          return;
        }

        console.discord(`${interaction.user.username} - [${interaction.commandName}]`);
        await interaction.deferReply().catch(() => {});
        if (memberRoles.some((role) => config.discord.commands.blacklistRoles.includes(role))) {
          throw new HypixelDiscordChatBridgeError("You are blacklisted from the bot.");
        }

        if (command.verificationCommand === true && config.verification.enabled === false) {
          throw new HypixelDiscordChatBridgeError("Verification is disabled.");
        }

        if (command.channelsCommand === true && config.statsChannels.enabled === false) {
          throw new HypixelDiscordChatBridgeError("Channel Stats is disabled.");
        }

        if (command.moderatorOnly === true && isModerator(interaction) === false) {
          throw new HypixelDiscordChatBridgeError("You don't have permission to use this command.");
        }

        if (command.verifiedOnly === true && isVerifiedMember(interaction) === false) {
          throw new HypixelDiscordChatBridgeError("You don't have permission to use this command.");
        }

        if (command.guildOnly === true && isGuildMember(interaction) === false) {
          throw new HypixelDiscordChatBridgeError("You don't have permission to use this command.");
        }

        if (command.linkedOnly === true && isLinkedMember(interaction) === false) {
          throw new HypixelDiscordChatBridgeError("You are not linked to a Minecraft account.");
        }

        if (command.requiresBot === true && isBotOnline() === false) {
          throw new HypixelDiscordChatBridgeError("Bot doesn't seem to be connected to Hypixel. Please try again.");
        }

        await command.execute(interaction);
      } else if (interaction.isButton()) {
        if (interaction.client.ticketService) {
          const handledByTicket = await interaction.client.ticketService.handleComponent(interaction).catch(() => false);
          if (handledByTicket) {
            return;
          }
        }

        if (interaction.client.carryService) {
          const handledByCarry = await interaction.client.carryService.handleComponent(interaction).catch(() => false);
          if (handledByCarry) {
            return;
          }
        }

        if (interaction.customId.startsWith("giveaway:")) {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const [, action, id, pageRaw] = interaction.customId.split(":");
          const giveawayId = Number(id);
          if (!Number.isInteger(giveawayId) || giveawayId <= 0) {
            return interaction.editReply({ embeds: [new ErrorEmbed("Invalid giveaway id.")] });
          }

          if (action === "join") {
            const result = await giveawayService.joinFromDiscord({
              giveawayId,
              member: interaction.member
            });
            if (!result.ok) {
              return interaction.editReply({ embeds: [new ErrorEmbed(result.reason)] });
            }

            return interaction.editReply({ embeds: [new SuccessEmbed(`Joined giveaway #${giveawayId}.`)] });
          }

          if (action === "leave") {
            const result = await giveawayService.leaveFromDiscord({
              giveawayId,
              userId: interaction.user.id
            });
            if (!result.ok) {
              return interaction.editReply({ embeds: [new ErrorEmbed(result.reason)] });
            }

            return interaction.editReply({ embeds: [new SuccessEmbed(`Left giveaway #${giveawayId}.`)] });
          }

          if (action === "entrants") {
            const memberRoleIds = interaction.member?.roles?.cache?.map((role) => role.id) || [];
            const isAdmin = giveawayService.isBridgeAdmin({ discordUserId: interaction.user.id, memberRoleIds });
            if (!isAdmin) {
              return interaction.editReply({ embeds: [new ErrorEmbed("Only bridge admins can view the entrant list.")] });
            }

            const giveaway = giveawayService.getGiveaway(giveawayId);
            if (!giveaway) {
              return interaction.editReply({ embeds: [new ErrorEmbed("Giveaway not found or already ended.")] });
            }

            const page = Number(pageRaw || 0);
            const rendered = giveawayService.buildEntrantsPage(giveaway, Number.isInteger(page) ? page : 0);
            return interaction.editReply({
              embeds: [rendered.embed],
              components: rendered.components
            });
          }

          return interaction.editReply({ embeds: [new ErrorEmbed("Invalid giveaway action.")] });
        }

        if (interaction.customId === PANEL_BUTTON_ID) {
          return interaction.client.joinRequestManager.handleCreateButton(interaction);
        }

        if (interaction.customId === PANEL_VERIFY_BUTTON_ID) {
          return interaction.client.joinRequestManager.handleVerifyButton(interaction);
        }

        if (JoinRequestManager.isJoinRequestComponent(interaction.customId)) {
          const parsed = JoinRequestManager.parseActionCustomId(interaction.customId);
          if (!parsed) {
            return interaction.reply({ content: "Invalid join request action.", ephemeral: true });
          }

          return interaction.client.joinRequestManager.handleModeratorAction({
            action: parsed.action,
            requestId: parsed.requestId,
            interaction
          });
        }

        if (interaction.customId === "joinRequestAccept") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const username = interaction?.message?.embeds?.[0]?.title.split(" ")?.[0] || undefined;
          if (!username) throw new HypixelDiscordChatBridgeError("Something is missing");
          bot.chat(`/g accept ${username}`);
          const embed = new SuccessEmbed(`Successfully accepted **${username}** into the guild.`);
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        }
      } else if (interaction.isStringSelectMenu()) {
        if (interaction.client.carryService) {
          const handledByCarry = await interaction.client.carryService.handleComponent(interaction).catch(() => false);
          if (handledByCarry) {
            return;
          }
        }
      } else if (interaction.isModalSubmit()) {
        if (interaction.client.ticketService) {
          const handledByTicketModal = await interaction.client.ticketService.handleModal(interaction).catch(() => false);
          if (handledByTicketModal) {
            return;
          }
        }
        if (interaction.client.carryService) {
          const handledByCarryModal = await interaction.client.carryService.handleModal(interaction).catch(() => false);
          if (handledByCarryModal) {
            return;
          }
        }

        if (interaction.customId === PANEL_MODAL_ID) {
          return interaction.client.joinRequestManager.handleCreateModal(interaction);
        }
        if (interaction.customId === PANEL_VERIFY_MODAL_ID) {
          return interaction.client.joinRequestManager.handleVerifyModal(interaction);
        }
      }
    } catch (error) {
      console.error(error);
      if (interaction.isAutocomplete?.()) {
        await interaction.respond([]).catch(() => {});
        return;
      }

      const errrorMessage = error instanceof HypixelDiscordChatBridgeError ? "" : "Please try again later. The error has been sent to the Developers.\n\n";

      const errorEmbed = new ErrorEmbed(`${errrorMessage}\`\`\`${error}\`\`\``);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed] });
      }

      if (error instanceof HypixelDiscordChatBridgeError === false) {
        const username = interaction.user.username ?? interaction.user.tag ?? "Unknown";
        const commandOptions = JSON.stringify(interaction.options?.data ?? []) ?? "Unknown";
        const commandName = interaction.commandName ?? "Unknown";
        const errorStack = error.stack ?? error ?? "Unknown";
        const userID = interaction.user.id ?? "Unknown";

        const errorLog = new ErrorEmbed(
          `Command: \`${commandName}\`\nOptions: \`${commandOptions}\`\nUser ID: \`${userID}\`\nUser: \`${username}\`\n\`\`\`${errorStack}\`\`\``
        );
        interaction.client.channels.cache.get(config.discord.channels.loggingChannel).send({
          content: `<@&${config.discord.commands.commandRole}>`,
          embeds: [errorLog]
        });
      }
    }
  }
};

function isBotOnline() {
  if (bot === undefined || bot._client.chat === undefined) {
    return false;
  }

  return true;
}

function isModerator(interaction) {
  const user = interaction.member;
  const userRoles = user.roles.cache.map((role) => role.id);

  if (config.discord.commands.checkPerms === true && !(userRoles.includes(config.discord.commands.commandRole) || config.discord.commands.users.includes(user.id))) {
    return false;
  }

  return true;
}
