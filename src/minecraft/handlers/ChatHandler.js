const { checkRequirements, generateEmbed } = require("../../discord/commands/requirementsCommand.js");
const { replaceAllRanks, replaceVariables } = require("../../contracts/helperFunctions.js");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hypixel = require("../../contracts/API/HypixelRebornAPI.js");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const eventHandler = require("../../contracts/EventHandler.js");
const { isUuid } = require("../../../API/utils/uuid.js");
const messages = require("../../../messages.json");
const config = require("../../../config.json");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const updateCommand = require("../../discord/commands/updateCommand.js");
const activityTracker = require("../../discord/other/activityTracker.js");

class StateHandler extends eventHandler {
  constructor(minecraft, command, discord) {
    super();
    this.minecraft = minecraft;
    this.discord = discord;
    this.command = command;
    this.uuidCache = new Map();
    this.uuidCacheTtlMs = 60 * 60 * 1000;
    this.guildMemberHistoryPath = "data/guildMemberHistory.json";
    this.guildMemberHistory = this.loadGuildMemberHistory();
  }

  registerEvents(bot) {
    this.bot = bot;
    this.bot.on("message", (message) => this.onMessage(message));
  }

  async onMessage(event) {
    const message = event.toString();
    const colouredMessage = event.toMotd();

    // NOTE: fixes "100/100❤     100/100✎ Mana" spam in the debug channel
    if (message.includes("✎ Mana") && message.includes("❤") && message.includes("/")) {
      return;
    }

    if (config.discord.channels.debugMode === true) {
      this.minecraft.broadcastMessage({
        fullMessage: colouredMessage,
        message: message,
        chat: "debugChannel"
      });
    }

    if (this.isLobbyJoinMessage(message) && config.discord.other.autoLimbo === true) {
      return bot.chat("/limbo");
    }

    if (this.isPartyMessage(message) && config.minecraft.fragBot.enabled === true) {
      const username = message.substr(54).startsWith("[") ? message.substr(54).split(" ")[1].trim() : message.substr(54).split(" ")[0].trim();

      const { blacklist, blacklisted, whitelist, whitelisted } = config.minecraft.fragBot;
      if (blacklist || whitelist) {
        const uuid = await getUUID(username);

        if (config.minecraft.fragBot.blacklist === true) {
          if (blacklisted.includes(username) || blacklisted.includes(uuid)) {
            return;
          }
        }

        const members = await hypixel.getGuild("player", bot.username).then(async (guild) => guild.members.map((member) => member.uuid));
        if ((config.minecraft.fragBot.whitelist && whitelisted.includes(username)) || members.includes(uuid)) {
          bot.chat(`/party accept ${username}`);
          await delay(Math.floor(Math.random() * (6900 - 4200 + 1)) + 4200);
          bot.chat(`/party leave`);
        }
      } else {
        bot.chat(`/party accept ${username}`);
        await delay(Math.floor(Math.random() * (6900 - 4200 + 1)) + 4200);
        bot.chat(`/party leave`);
      }
    }

    if (this.isRequestMessage(message)) {
      const username = this.extractRequestUsername(message);
      if (!username) {
        return;
      }

      const rejoinContext = await this.getRejoinContext(username);
      if (rejoinContext?.departure) {
        await this.sendOfficerRejoinMessage(username, rejoinContext);
      }

      const uuid = await getUUID(username).catch(() => null);
      if (uuid && config.minecraft.guildRequirements.enabled) {
        const playerInfo = await checkRequirements(uuid).catch(() => null);
        if (!playerInfo) {
          return;
        }

        bot.chat(
          `/oc ${playerInfo.nickname} ${playerInfo.meetRequirements ? "meets" : "Doesn't meet"} Requirements. [BW] [${
            playerInfo.bwLevel
          }✫] FKDR: ${playerInfo.bwFKDR} | [SW] [${playerInfo.swLevel}✫] KDR: ${playerInfo.swKDR} | [Duels] Wins: ${
            playerInfo.duelsWins
          } WLR: ${playerInfo.dWLR} | SB Level: ${playerInfo.skyblockLevel}`
        );
        await delay(1000);

        if (playerInfo.meetRequirements === true && config.minecraft.guildRequirements.autoAccept) {
          bot.chat(`/guild accept ${username}`);
        }

        if (config.discord.joinRequests?.enabled) {
          await this.discord.joinRequestManager.onIngameRequest(username).catch(console.error);
        } else {
          const statsEmbed = generateEmbed(playerInfo);
          const acceptButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("joinRequestAccept").setLabel("Accept Request").setStyle(ButtonStyle.Success)
          );
          await client.channels.cache.get(`${config.discord.channels.loggingChannel}`).send({ embeds: [statsEmbed], components: [acceptButton] });
        }
      } else if (config.discord.joinRequests?.enabled) {
        await this.discord.joinRequestManager.onIngameRequest(username).catch(console.error);
      }
    }

    if (this.isLoginMessage(message)) {
      const username = message.split(">")[1].trim().split("joined.")[0].trim();
      const uuid = await getUUID(username).catch(() => null);
      if (uuid) {
        this.cacheUuid(username, uuid);
        activityTracker.recordLogin(uuid);
      }

      if (config.discord.other.joinMessage === true) {
        return this.minecraft.broadcastPlayerToggle({
          fullMessage: colouredMessage,
          username: username,
          message: replaceVariables(messages.loginMessage, { username }),
          color: 2067276,
          channel: "Guild"
        });
      }
    }

    if (this.isLogoutMessage(message)) {
      const username = message.split(">")[1].trim().split("left.")[0].trim();
      const uuid = await getUUID(username).catch(() => null);
      if (uuid) {
        this.cacheUuid(username, uuid);
        activityTracker.recordLogout(uuid);
      }

      if (config.discord.other.joinMessage === true) {
        return this.minecraft.broadcastPlayerToggle({
          fullMessage: colouredMessage,
          username: username,
          message: replaceVariables(messages.logoutMessage, { username }),
          color: 15548997,
          channel: "Guild"
        });
      }
    }

    if (this.isJoinMessage(message)) {
      const username = this.getUsernameFromEventMessage(message);
      await this.discord.joinRequestManager.onIngameAccepted(username).catch(() => {});
      setTimeout(() => this.tryToUpdateUser(username), 15000);
      const rejoinContext = await this.getRejoinContext(username);

      await this.sendGuildCommandWithRateLimitRetry(`/gc ${replaceVariables(messages.guildJoinMessage, { prefix: config.minecraft.bot.prefix })}`, {
        delayMs: 1000,
        maxRetries: 1,
        retryDelayMs: 2500
      });

      let joinedMessage = replaceVariables(messages.joinMessage, { username });
      if (rejoinContext?.departure) {
        const departure = rejoinContext.departure;
        const departureLabel = departure.type === "kicked" ? "kicked" : "left";
        const oldUsernameLine = rejoinContext.oldUsername ? `\nOld username: \`${rejoinContext.oldUsername}\`` : "";
        const departureTimestamp = this.formatHistoryDiscordTimestamp(departure.date);
        const detailLines = [
          `\nPrevious departure: ${departureLabel} on ${departureTimestamp || `\`${this.formatHistoryDate(departure.date)}\``}`,
          departure.type === "kicked" ? `\nKicked by: \`${departure.kickedBy || "Unknown"}\`` : "",
          departure.type === "kicked" ? `\nKick reason: \`${departure.reason || "Unknown"}\`` : ""
        ].join("");
        joinedMessage = `${joinedMessage}\n\nPreviously in guild: yes${oldUsernameLine}${detailLines}`;
      }

      const broadcastMessage = {
        message: joinedMessage,
        title: `Member Joined`,
        icon: `https://mc-heads.net/avatar/${username}`,
        color: 2067276
      };

      return [
        this.minecraft.broadcastHeadedEmbed({ ...broadcastMessage, channel: "Logger" }),
        this.minecraft.broadcastHeadedEmbed({ ...broadcastMessage, channel: "Guild" })
      ];
    }

    if (this.isLeaveMessage(message)) {
      const username = this.getUsernameFromEventMessage(message);
      setTimeout(() => this.tryToUpdateUser(username), 15000);
      await this.recordGuildDeparture({
        username,
        type: "left"
      });

      const broadcastMessage = {
        message: replaceVariables(messages.leaveMessage, { username }),
        title: `Member Left`,
        icon: `https://mc-heads.net/avatar/${username}`,
        color: 15548997
      };

      return [
        this.minecraft.broadcastHeadedEmbed({ ...broadcastMessage, channel: "Logger" }),
        this.minecraft.broadcastHeadedEmbed({ ...broadcastMessage, channel: "Guild" })
      ];
    }

    if (this.isKickMessage(message)) {
      const username = this.getUsernameFromEventMessage(message);
      setTimeout(() => this.tryToUpdateUser(username), 15000);
      const kickDetails = this.extractKickDetails(message);
      await this.recordGuildDeparture({
        username,
        type: "kicked",
        kickedBy: kickDetails?.kickedBy || null,
        reason: kickDetails?.reason || null
      });

      const broadcastMessage = {
        message: replaceVariables(messages.kickMessage, { username }),
        title: `Member Kicked`,
        icon: `https://mc-heads.net/avatar/${username}`,
        color: 15548997
      };

      return [
        this.minecraft.broadcastHeadedEmbed({ ...broadcastMessage, channel: "Logger" }),
        this.minecraft.broadcastHeadedEmbed({ ...broadcastMessage, channel: "Guild" })
      ];
    }

    if (this.isPromotionMessage(message)) {
      const username = this.getUsernameFromEventMessage(message);
      const rank = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(" to ")
        .pop()
        .trim();

      setTimeout(() => this.tryToUpdateUser(username), 15000);

      const broadcastMessage = {
        message: replaceVariables(messages.promotionMessage, {
          username,
          rank
        }),
        title: `Member Promoted`,
        icon: `https://mc-heads.net/avatar/${username}`,
        color: 2067276
      };

      return [
        this.minecraft.broadcastCleanEmbed({ ...broadcastMessage, channel: "Guild" }),
        this.minecraft.broadcastCleanEmbed({ ...broadcastMessage, channel: "Logger" })
      ];
    }

    if (this.isDemotionMessage(message)) {
      const username = this.getUsernameFromEventMessage(message);
      const rank = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(" to ")
        .pop()
        .trim();
      setTimeout(() => this.tryToUpdateUser(username), 15000);

      const broadcastMessage = {
        message: replaceVariables(messages.demotionMessage, {
          username,
          rank
        }),
        title: `Member Demoted`,
        icon: `https://mc-heads.net/avatar/${username}`,
        color: 15548997
      };

      return [
        this.minecraft.broadcastCleanEmbed({ ...broadcastMessage, channel: "Guild" }),
        this.minecraft.broadcastCleanEmbed({ ...broadcastMessage, channel: "Logger" })
      ];
    }

    if (this.isCannotMuteMoreThanOneMonth(message)) {
      return this.minecraft.broadcastCleanEmbed({
        message: messages.cannotMuteMoreThanOneMonthMessage,
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isBlockedMessage(message)) {
      const blockedMsg = message.match(/".+"/g)[0].slice(1, -1);
      return this.minecraft.broadcastCleanEmbed({
        message: replaceVariables(messages.messageBlockedByHypixel, {
          message: blockedMsg
        }),
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isRepeatMessage(message)) {
      return client.channels.cache.get(config.discord.channels.guildChatChannel).send({
        embeds: [
          {
            color: 15548997,
            description: messages.repeatMessage
          }
        ]
      });
    }

    if (this.isNoPermission(message)) {
      return this.minecraft.broadcastCleanEmbed({
        message: messages.noPermissionMessage,
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isMuted(message)) {
      const formattedMessage = message.split(" ").slice(1).join(" ");
      this.minecraft.broadcastHeadedEmbed({
        message: formattedMessage.charAt(0).toUpperCase() + formattedMessage.slice(1),

        title: `Bot is currently muted for a Major Chat infraction.`,
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isIncorrectUsage(message)) {
      return this.minecraft.broadcastCleanEmbed({
        message: message.split("'").join("`"),
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isAlreadyBlacklistedMessage(message)) {
      return this.minecraft.broadcastHeadedEmbed({
        message: messages.alreadyBlacklistedMessage,
        title: `Blacklist`,
        color: 2067276,
        channel: "Guild"
      });
    }

    if (this.isBlacklistMessage(message)) {
      const username = message.split(" ")[1];

      return [
        this.minecraft.broadcastHeadedEmbed({
          message: replaceVariables(messages.blacklistMessage, {
            username
          }),
          title: `Blacklist`,
          color: 2067276,
          channel: "Guild"
        }),
        this.minecraft.broadcastHeadedEmbed({
          message: replaceVariables(messages.blacklistMessage, {
            username
          }),
          title: `Blacklist`,
          color: 2067276,
          channel: "Logger"
        })
      ];
    }

    if (this.isBlacklistRemovedMessage(message)) {
      const username = message.split(" ")[1];
      return [
        this.minecraft.broadcastHeadedEmbed({
          message: replaceVariables(messages.blacklistRemoveMessage, {
            username
          }),
          title: `Blacklist`,
          color: 2067276,
          channel: "Guild"
        }),
        this.minecraft.broadcastHeadedEmbed({
          message: replaceVariables(messages.blacklistRemoveMessage, {
            username
          }),
          title: `Blacklist`,
          color: 2067276,
          channel: "Logger"
        })
      ];
    }

    if (this.isOnlineInvite(message)) {
      const username = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[2];
      return [
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.onlineInvite, { username }),
          color: 2067276,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.onlineInvite, { username }),
          color: 2067276,
          channel: "Logger"
        })
      ];
    }

    if (this.isOfflineInvite(message)) {
      const username = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[6]
        .match(/\w+/g)[0];
      return [
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.offlineInvite, { username }),
          color: 2067276,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.offlineInvite, { username }),
          color: 2067276,
          channel: "Logger"
        })
      ];
    }

    if (this.isFailedInvite(message)) {
      return [
        this.minecraft.broadcastCleanEmbed({
          message: message.replace(/\[(.*?)\]/g, "").trim(),
          color: 15548997,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: message.replace(/\[(.*?)\]/g, "").trim(),
          color: 15548997,
          channel: "Logger"
        })
      ];
    }

    if (this.isGuildMuteMessage(message)) {
      const time = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[7];
      return [
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.guildMuteMessage, { time }),
          color: 15548997,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.guildMuteMessage, { time }),
          color: 15548997,
          channel: "Logger"
        })
      ];
    }

    if (this.isGuildUnmuteMessage(message)) {
      return [
        this.minecraft.broadcastCleanEmbed({
          message: messages.guildUnmuteMessage,
          color: 2067276,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: messages.guildUnmuteMessage,
          color: 2067276,
          channel: "Logger"
        })
      ];
    }

    if (this.isUserMuteMessage(message)) {
      const username = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[3]
        .replace(/[^\w]+/g, "");
      const time = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[5];
      return [
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.userMuteMessage, {
            username,
            time
          }),
          color: 15548997,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.userMuteMessage, {
            username,
            time
          }),
          color: 15548997,
          channel: "Logger"
        })
      ];
    }

    if (this.isUserUnmuteMessage(message)) {
      const username = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[3];
      return [
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.userUnmuteMessage, {
            username
          }),
          color: 2067276,
          channel: "Guild"
        }),
        this.minecraft.broadcastCleanEmbed({
          message: replaceVariables(messages.userUnmuteMessage, {
            username
          }),
          color: 2067276,
          channel: "Logger"
        })
      ];
    }

    if (this.isSetrankFail(message)) {
      return this.minecraft.broadcastCleanEmbed({
        message: messages.setrankFailMessage,
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isGuildQuestCompletion(message)) {
      this.minecraft.broadcastHeadedEmbed({
        title: "Guild Quest Completion",
        message: message,
        color: 15844367,
        channel: "Guild"
      });
    }

    if (this.isAlreadyMuted(message)) {
      return this.minecraft.broadcastCleanEmbed({
        message: messages.alreadyMutedMessage,
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isNotInGuild(message)) {
      const username = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(" ")[0];
      return this.minecraft.broadcastCleanEmbed({
        message: replaceVariables(messages.notInGuildMessage, {
          username
        }),
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isLowestRank(message)) {
      const username = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(" ")[0];
      return this.minecraft.broadcastCleanEmbed({
        message: replaceVariables(messages.lowestRankMessage, {
          username
        }),
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isAlreadyHasRank(message)) {
      return this.minecraft.broadcastCleanEmbed({
        message: messages.alreadyHasRankMessage,
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isTooFast(message)) {
      return console.warn(message);
    }

    if (this.isPlayerNotFound(message)) {
      const username = message.split(" ")[8].slice(1, -1);
      return this.minecraft.broadcastCleanEmbed({
        message: replaceVariables(messages.playerNotFoundMessage, {
          username
        }),
        color: 15548997,
        channel: "Guild"
      });
    }

    if (this.isGuildLevelUpMessage(message)) {
      const level = message
        .replace(/\[(.*?)\]/g, "")
        .trim()
        .split(/ +/g)[5];
      return this.minecraft.broadcastCleanEmbed({
        message: replaceVariables(messages.guildLevelUpMessage, { level }),
        color: 16766720,
        channel: "Guild"
      });
    }

    /*if (this.isPartyMessage(message)) {
      this.minecraft.broadcastCleanEmbed({ 
        message: `${message}`, 
        color: 15548997, 
        channel: 'Guild' 
      })  
    }*/

    const privateMessage = this.getIncomingPrivateMessage(message);
    if (privateMessage && this.isCommand(privateMessage.message) && this.isGiveawayCommand(privateMessage.message)) {
      return this.command.handle(privateMessage.username, privateMessage.message, false, "pm");
    }

    const regex =
      config.discord.other.messageMode === "minecraft"
        ? /^(?<chatType>§[0-9a-fA-F](Guild|Officer)) > (?<rank>§[0-9a-fA-F](?:\[.*?\])?)?\s*(?<username>[^§\s]+)\s*(?:(?<guildRank>§[0-9a-fA-F](?:\[.*?\])?))?\s*§f: (?<message>.*)/
        : /^(?<chatType>\w+) > (?:(?:\[(?<rank>[^\]]+)\] )?(?:(?<username>\w+)(?: \[(?<guildRank>[^\]]+)\])?: )?)?(?<message>.+)$/;

    const match = (config.discord.other.messageMode === "minecraft" ? colouredMessage : message).match(regex);

    if (!match) {
      return;
    }

    if (this.isDiscordMessage(match.groups.message) === false) {
      const { chatType, rank, username, guildRank = "[Member]", message } = match.groups;
      if (message.includes("replying to") && username === this.bot.username) {
        return;
      }

      await this.recordIngameChatActivity(username);

      this.minecraft.broadcastMessage({
        fullMessage: colouredMessage,
        chat: chatType,
        chatType,
        username,
        rank,
        guildRank,
        message,
        color: this.minecraftChatColorToHex(this.getRankColor(colouredMessage))
      });
    }

    if (this.isCommand(match.groups.message)) {
      const officer = match.groups.chatType.includes("Officer");
      if (this.isDiscordMessage(match.groups.message) === true) {
        const { player, command } = this.getCommandData(match.groups.message);

        return this.command.handle(player, command, officer, officer ? "officer" : "guild");
      }

      return this.command.handle(match.groups.username, match.groups.message, officer, officer ? "officer" : "guild");
    }
  }

  getIncomingPrivateMessage(message) {
    const match = String(message || "").match(/^From\s+(?:\[(?<rank>[^\]]+)\]\s+)?(?<username>[A-Za-z0-9_]{3,16}):\s*(?<message>.+)$/i);
    if (!match?.groups?.username || !match?.groups?.message) {
      return null;
    }

    return {
      username: match.groups.username,
      message: match.groups.message
    };
  }

  isGiveawayCommand(message) {
    const clean = String(message || "").trim();
    if (!clean.startsWith(config.minecraft.bot.prefix)) {
      return false;
    }

    const command = clean.slice(config.minecraft.bot.prefix.length).trim().split(/\s+/)[0]?.toLowerCase();
    return ["giveaway", "gaw", "giveaways", "activegiveaways", "ags", "joingiveaway", "jg", "leavegiveaway", "lg"].includes(command);
  }

  isDiscordMessage(message) {
    const isDiscordMessage = /^(?<username>(?!https?:\/\/)[^\s»:>]+)\s*[»:>]\s*(?<message>.*)/;

    const match = message.match(isDiscordMessage);
    if (match && ["Party", "Guild", "Officer"].includes(match.groups.username)) {
      return false;
    }

    return isDiscordMessage.test(message);
  }

  isCommand(message) {
    const regex = new RegExp(`^(?<prefix>[${config.minecraft.bot.prefix}-])(?<command>\\S+)(?:\\s+(?<args>.+))?\\s*$`);

    if (regex.test(message) === false) {
      const getMessage = /^(?<username>(?!https?:\/\/)[^\s»:>]+)\s*[»:>]\s*(?<message>.*)/;

      const match = message.match(getMessage);
      if (match === null || match.groups.message === undefined) {
        return false;
      }

      return regex.test(match.groups.message);
    }

    return regex.test(message);
  }

  getCommandData(message) {
    const regex = /^(?<player>[^\s»:>\s]+(?:\s+[^\s»:>\s]+)*)\s*[»:>\s]\s*(?<command>.*)/;

    const match = message.match(regex);
    if (match === null) {
      return {};
    }

    return match.groups;
  }

  getRankColor(message) {
    const regex = /§\w*\[(\w*[a-zA-Z0-9]+§?\w*(?:\+{0,2})?§?\w*)\] /g;

    const match = message.match(regex);
    if (match) {
      const color = match[0]
        .match(/§(\w)/g)
        .filter((value, index, self) => self.indexOf(value) === index)
        .at(-1);

      return color.slice(1);
    }

    return "7";
  }

  getUsernameFromEventMessage(message) {
    const regex = /(?:\[(?<rank>[^\]]+)\] )?(?<username>[^\s]+) (?<event>.+)/;

    const match = message.match(regex);
    if (match === null) {
      return "";
    }

    return match.groups.username;
  }

  isMessageFromBot(username) {
    return bot.username === username;
  }

  isAlreadyBlacklistedMessage(message) {
    return message.includes(`You've already blocked that player! /block remove <player> to unblock them!`) && !message.includes(":");
  }

  isBlacklistRemovedMessage(message) {
    return message.startsWith("Unblocked") && message.endsWith(".") && !message.includes(":");
  }

  isBlacklistMessage(message) {
    return message.startsWith("Blocked") && message.endsWith(".") && !message.includes(":");
  }

  isGuildMessage(message) {
    return message.startsWith("Guild >") && message.includes(":");
  }

  isOfficerMessage(message) {
    return message.startsWith("Officer >") && message.includes(":");
  }

  isGuildQuestCompletion(message) {
    return message.includes("GUILD QUEST TIER ") && message.includes("COMPLETED") && !message.includes(":");
  }

  isLoginMessage(message) {
    return message.startsWith("Guild >") && message.endsWith("joined.") && !message.includes(":");
  }

  isLogoutMessage(message) {
    return message.startsWith("Guild >") && message.endsWith("left.") && !message.includes(":");
  }

  isJoinMessage(message) {
    return message.includes("joined the guild!") && !message.includes(":");
  }

  isLeaveMessage(message) {
    return message.includes("left the guild!") && !message.includes(":");
  }

  isKickMessage(message) {
    return message.includes("was kicked from the guild by") && !message.includes(":");
  }

  isPartyMessage(message) {
    return message.includes("has invited you to join their party!") && !message.includes(":");
  }

  isPromotionMessage(message) {
    return message.includes("was promoted from") && !message.includes(":");
  }

  isDemotionMessage(message) {
    return message.includes("was demoted from") && !message.includes(":");
  }

  isRequestMessage(message) {
    const normalized = String(message || "").toLowerCase();
    return normalized.includes("requested to join") && normalized.includes("guild");
  }

  extractRequestUsername(message) {
    const cleaned = String(message || "")
      .replaceAll("-----------------------------------------------------\n", "")
      .trim();
    const withoutPrefix = cleaned.replace(/^guild\s*>\s*/i, "");
    const normalized = replaceAllRanks(withoutPrefix).trim();

    const match = normalized.match(/^(?<username>[A-Za-z0-9_]{3,16})(?:\s+has)?\s+requested to join(?:\s+(?:the|your))?\s+guild!?/i);
    if (match?.groups?.username) {
      return match.groups.username;
    }

    const fallback = normalized.match(/\b([A-Za-z0-9_]{3,16})\b/);
    return fallback?.[1] || null;
  }

  isBlockedMessage(message) {
    return message.includes("We blocked your comment") && !message.includes(":");
  }

  isRepeatMessage(message) {
    return message == "You cannot say the same message twice!";
  }

  isNoPermission(message) {
    return (
      (message.includes("You must be the Guild Master to use that command!") ||
        message.includes("You do not have permission to use this command!") ||
        message.includes(
          "I'm sorry, but you do not have permission to perform this command. Please contact the server administrators if you believe that this is in error."
        ) ||
        message.includes("You cannot mute a guild member with a higher guild rank!") ||
        message.includes("You cannot kick this player!") ||
        message.includes("You can only promote up to your own rank!") ||
        message.includes("You cannot mute yourself from the guild!") ||
        message.includes("is the guild master so can't be demoted!") ||
        message.includes("is the guild master so can't be promoted anymore!") ||
        message.includes("You do not have permission to kick people from the guild!")) &&
      !message.includes(":")
    );
  }

  isIncorrectUsage(message) {
    return message.includes("Invalid usage!") && !message.includes(":");
  }

  isOnlineInvite(message) {
    return message.includes("You invited") && message.includes("to your guild. They have 5 minutes to accept.") && !message.includes(":");
  }

  isOfflineInvite(message) {
    return message.includes("You sent an offline invite to") && message.includes("They will have 5 minutes to accept once they come online!") && !message.includes(":");
  }

  isFailedInvite(message) {
    return (
      (message.includes("is already in another guild!") ||
        message.includes("You cannot invite this player to your guild!") ||
        (message.includes("You've already invited") && message.includes("to your guild! Wait for them to accept!")) ||
        message.includes("is already in your guild!")) &&
      !message.includes(":")
    );
  }

  isUserMuteMessage(message) {
    return message.includes("has muted") && message.includes("for") && !message.includes(":");
  }

  isUserUnmuteMessage(message) {
    return message.includes("has unmuted") && !message.includes(":");
  }

  isCannotMuteMoreThanOneMonth(message) {
    return message.includes("You cannot mute someone for more than one month") && !message.includes(":");
  }

  isGuildMuteMessage(message) {
    return message.includes("has muted the guild chat for") && !message.includes(":");
  }

  isGuildUnmuteMessage(message) {
    return message.includes("has unmuted the guild chat!") && !message.includes(":");
  }

  isSetrankFail(message) {
    return message.includes("I couldn't find a rank by the name of ") && !message.includes(":");
  }

  isAlreadyMuted(message) {
    return message.includes("This player is already muted!") && !message.includes(":");
  }

  isNotInGuild(message) {
    return message.includes(" is not in your guild!") && !message.includes(":");
  }

  isLowestRank(message) {
    return message.includes("is already the lowest rank you've created!") && !message.includes(":");
  }

  isAlreadyHasRank(message) {
    return message.includes("They already have that rank!") && !message.includes(":");
  }

  isLobbyJoinMessage(message) {
    return (message.endsWith(" the lobby!") || message.endsWith(" the lobby! <<<")) && message.includes("[MVP+");
  }

  isTooFast(message) {
    return message.includes("You are sending commands too fast! Please slow down.") && !message.includes(":");
  }

  isMuted(message) {
    return message.includes("Your mute will expire in") && !message.includes(":");
  }

  isPlayerNotFound(message) {
    return message.startsWith(`Can't find a player by the name of`);
  }

  isGuildLevelUpMessage(message) {
    return message.includes("The Guild has reached Level") && !message.includes("!");
  }

  minecraftChatColorToHex(color) {
    switch (color) {
      case "0":
        return "#000000";
      case "1":
        return "#0000AA";
      case "2":
        return "#00AA00";
      case "3":
        return "#00AAAA";
      case "4":
        return "#AA0000";
      case "5":
        return "#AA00AA";
      case "6":
        return "#FFAA00";
      case "7":
        return "#AAAAAA";
      case "8":
        return "#555555";
      case "9":
        return "#5555FF";
      case "a":
        return "#55FF55";
      case "b":
        return "#55FFFF";
      case "c":
        return "#FF5555";
      case "d":
        return "#FF55FF";
      case "e":
        return "#FFFF55";
      case "f":
        return "#FFFFFF";
      default:
        return "#FFFFFF";
    }
  }

  cacheUuid(username, uuid) {
    if (!username || !uuid) {
      return;
    }

    this.uuidCache.set(username.toLowerCase(), {
      uuid,
      expiresAt: Date.now() + this.uuidCacheTtlMs
    });
  }

  loadGuildMemberHistory() {
    const defaultState = { version: 1, members: {} };

    try {
      if (!existsSync(this.guildMemberHistoryPath)) {
        writeFileSync(this.guildMemberHistoryPath, JSON.stringify(defaultState, null, 2));
        return defaultState;
      }

      const raw = readFileSync(this.guildMemberHistoryPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return defaultState;
      }

      if (parsed.version === 1 && parsed.members && typeof parsed.members === "object") {
        return parsed;
      }

      if (typeof parsed === "object") {
        return { version: 1, members: parsed };
      }
    } catch {
      // ignore file errors and continue with defaults
    }

    return defaultState;
  }

  saveGuildMemberHistory() {
    try {
      writeFileSync(this.guildMemberHistoryPath, JSON.stringify(this.guildMemberHistory, null, 2));
    } catch {
      // ignore file errors
    }
  }

  normalizeUuid(uuid) {
    return String(uuid || "")
      .replaceAll("-", "")
      .toLowerCase();
  }

  formatHistoryDate(date) {
    const ts = typeof date === "number" ? date : Date.parse(date);
    if (Number.isNaN(ts)) {
      return "Unknown";
    }

    const iso = new Date(ts).toISOString();
    return `${iso.slice(0, 16).replace("T", " ")} UTC`;
  }

  formatHistoryDiscordTimestamp(date) {
    const ts = typeof date === "number" ? date : Date.parse(date);
    if (Number.isNaN(ts)) {
      return null;
    }

    return `<t:${Math.floor(ts / 1000)}:f>`;
  }

  extractKickDetails(message) {
    const normalized = replaceAllRanks(String(message || "").trim());
    const match = normalized.match(
      /^(?<username>[A-Za-z0-9_]{3,16}) was kicked from the guild by (?<kickedBy>[A-Za-z0-9_]{3,16})(?: for (?<reason>.+?))?!?$/i
    );

    if (!match?.groups) {
      return null;
    }

    return {
      username: match.groups.username,
      kickedBy: match.groups.kickedBy,
      reason: match.groups.reason ? match.groups.reason.trim().replace(/[.!]$/, "") : null
    };
  }

  async recordGuildDeparture({ username, type, kickedBy = null, reason = null }) {
    try {
      if (!username || !["left", "kicked"].includes(type)) {
        return;
      }

      let uuid = this.getCachedUuid(username);
      if (!uuid) {
        uuid = await getUUID(username).catch(() => null);
        if (!uuid) {
          return;
        }
      }

      this.cacheUuid(username, uuid);

      const normalizedUuid = this.normalizeUuid(uuid);
      const members = this.guildMemberHistory.members || {};
      const existing = members[normalizedUuid] || {};

      const previousNames = Array.isArray(existing.previousNames) ? [...existing.previousNames] : [];
      if (existing.lastKnownUsername && existing.lastKnownUsername.toLowerCase() !== username.toLowerCase()) {
        previousNames.push(existing.lastKnownUsername);
      }

      const dedupedPreviousNames = [...new Set(previousNames)];

      members[normalizedUuid] = {
        uuid: normalizedUuid,
        lastKnownUsername: username,
        previousNames: dedupedPreviousNames,
        departure: {
          type,
          date: Date.now(),
          kickedBy: type === "kicked" ? kickedBy : null,
          reason: type === "kicked" ? reason : null
        }
      };

      this.guildMemberHistory.members = members;
      this.saveGuildMemberHistory();
    } catch {
      // ignore history errors
    }
  }

  async getRejoinContext(username) {
    try {
      if (!username) {
        return null;
      }

      let uuid = this.getCachedUuid(username);
      if (!uuid) {
        uuid = await getUUID(username).catch(() => null);
        if (!uuid) {
          return null;
        }
      }

      this.cacheUuid(username, uuid);

      const normalizedUuid = this.normalizeUuid(uuid);
      const existing = this.guildMemberHistory.members?.[normalizedUuid];
      if (!existing?.departure) {
        return null;
      }

      const oldUsername =
        existing.lastKnownUsername && existing.lastKnownUsername.toLowerCase() !== username.toLowerCase() ? existing.lastKnownUsername : null;

      return {
        uuid: normalizedUuid,
        oldUsername,
        departure: existing.departure
      };
    } catch {
      return null;
    }
  }

  async sendOfficerRejoinMessage(username, rejoinContext) {
    try {
      if (!rejoinContext?.departure) {
        return;
      }

      const departure = rejoinContext.departure;
      const action = departure.type === "kicked" ? "got kicked" : "left";
      const oldUsernameText = rejoinContext.oldUsername ? ` (Old username: "${rejoinContext.oldUsername}")` : "";
      const kickSuffix =
        departure.type === "kicked" ? ` for: "${departure.reason || "Unknown"}" by "${departure.kickedBy || "Unknown"}"` : "";
      const message = `User "${username}" was part of the guild before${oldUsernameText}. They ${action} on "${this.formatHistoryDate(
        departure.date
      )}"${kickSuffix}`;

      await this.sendGuildCommandWithRateLimitRetry(`/oc ${message}`, {
        delayMs: 1800,
        maxRetries: 2,
        retryDelayMs: 3000
      });
    } catch {
      // ignore officer chat errors
    }
  }

  async sendGuildCommandWithRateLimitRetry(command, { delayMs = 0, maxRetries = 0, retryDelayMs = 2500 } = {}) {
    try {
      if (!command || typeof command !== "string") {
        return false;
      }

      if (delayMs > 0) {
        await delay(delayMs);
      }

      const attempts = Math.max(0, Number(maxRetries || 0)) + 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const rateLimited = await new Promise((resolve) => {
          let settled = false;

          const cleanup = () => {
            bot.removeListener("message", messageListener);
            clearTimeout(timeout);
          };

          const finish = (value) => {
            if (settled) {
              return;
            }

            settled = true;
            cleanup();
            resolve(value);
          };

          const messageListener = (event) => {
            const receivedMessage = event.toString();
            if (receivedMessage.includes("You are sending commands too fast!")) {
              finish(true);
            }
          };

          const timeout = setTimeout(() => finish(false), 1500);
          bot.on("message", messageListener);

          try {
            bot.chat(command);
          } catch {
            finish(false);
          }
        });

        if (rateLimited === false) {
          return true;
        }

        if (attempt < attempts - 1) {
          await delay(retryDelayMs);
        }
      }
    } catch {
      // ignore send/retry errors
    }

    return false;
  }

  getCachedUuid(username) {
    if (!username) {
      return null;
    }

    const cacheEntry = this.uuidCache.get(username.toLowerCase());
    if (!cacheEntry) {
      return null;
    }

    if (cacheEntry.expiresAt < Date.now()) {
      this.uuidCache.delete(username.toLowerCase());
      return null;
    }

    return cacheEntry.uuid;
  }

  async recordIngameChatActivity(username) {
    try {
      let uuid = this.getCachedUuid(username);
      if (!uuid) {
        uuid = await getUUID(username).catch(() => null);
        if (!uuid) {
          return;
        }

        this.cacheUuid(username, uuid);
      }

      activityTracker.recordChat(uuid);
    } catch {
      // ignore tracking errors
    }
  }

  async tryToUpdateUser(uuid) {
    try {
      if (config.verification.enabled === false) {
        return;
      }

      if (isUuid(uuid) === false) {
        uuid = await getUUID(uuid);
      }

      const linkedData = readFileSync("data/linked.json");
      if (linkedData === undefined) {
        return;
      }

      const linked = JSON.parse(linkedData.toString());
      if (linked === undefined) {
        return;
      }

      const discordId = linked[uuid];
      updateCommand.updateRoles({ discordId, uuid });

      console.log(`Updated roles for ${uuid}`);
    } catch {
      //
    }
  }
}

module.exports = StateHandler;
