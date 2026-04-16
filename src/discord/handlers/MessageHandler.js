const config = require('../../config');
const { unemojify } = require("node-emoji");
const { getAllLinks, getUuidByDiscordId } = require("../../contracts/linkedStore.js");
const activityTracker = require("../other/activityTracker.js");
const { carryDatabase } = require("../other/carryDatabase.js");

const GUILD_MUTED_USERS_KEY = "guild_muted_users_json";

class MessageHandler {
  constructor(discord, command) {
    this.discord = discord;
    this.command = command;
    this.linkedCache = null;
    this.linkedCacheExpiresAt = 0;
    this.noticeCooldown = new Map();
  }

  async onMessage(message) {
    try {
      if (message.author.id === client.user.id || !this.shouldBroadcastMessage(message)) {
        return;
      }

      const discordUser = await message.guild.members.fetch(message.author.id);
      const memberRoles = discordUser.roles.cache.map((role) => role.id);
      if (memberRoles.some((role) => config.discord.commands.blacklistRoles.includes(role))) {
        return;
      }

      const content = this.stripDiscordContent(message).trim();
      if (content.length === 0 && message.attachments.size === 0) {
        return;
      }

      const username = message.member.displayName ?? message.author.username;
      if (username === undefined || username.length === 0) {
        return;
      }

      const formattedUsername = unemojify(username);

      const messageData = {
        member: message.member.user,
        channel: message.channel.id,
        username: formattedUsername.replaceAll(" ", ""),
        message: content,
        replyingTo: await this.fetchReply(message),
        discord: message
      };

      if (messageData.message.length === 0) {
        return;
      }

      const guildChatChannelId = String(config.discord.channels.guildChatChannel || "");
      const officerChannelId = String(config.discord.channels.officerChannel || "");
      const isGuildBridgeChannel = message.channel.id === guildChatChannelId;
      const isBridgeChatChannel = message.channel.id === guildChatChannelId || message.channel.id === officerChannelId;
      if (isBridgeChatChannel && !this.isLinkedBridgeUser(message.author.id)) {
        await message.react("\u274C").catch(() => {});
        await this.sendTemporaryNotice(message, "Only linked users can use chat bridge. Use `/verify`.");
        return;
      }

      if (isBridgeChatChannel && this.isGuildMutedFromBridge(message)) {
        await message.react("\u{1F507}").catch(() => {});
        await this.sendTemporaryNotice(message, "You are currently muted in guild chat and cannot use the bridge.");
        return;
      }

      this.recordActivity(message.author.id);

      if (messageData.message.length > 220) {
        const messageParts = messageData.message.match(/.{1,200}/g);
        if (messageParts === null) {
          return;
        }

        for (const part of messageParts) {
          messageData.message = part;
          this.discord.broadcastMessage(messageData);
          await new Promise((resolve) => setTimeout(resolve, 1000));

          if (messageParts.indexOf(part) >= 3) {
            messageData.message = "Message too long. Truncated.";
            this.discord.broadcastMessage(messageData);
            return;
          }
        }

        return;
      }

      this.discord.broadcastMessage(messageData);
    } catch (error) {
      console.error(error);
    }
  }

  getLinkedData() {
    const now = Date.now();
    if (this.linkedCache && now < this.linkedCacheExpiresAt) {
      return this.linkedCache;
    }

    this.linkedCache = getAllLinks();

    this.linkedCacheExpiresAt = now + 60000;
    return this.linkedCache;
  }

  recordActivity(discordId) {
    try {
      const linked = this.getLinkedData();
      const uuid = Object.entries(linked).find(([, id]) => id === discordId)?.[0];
      if (uuid) {
        activityTracker.recordChat(uuid);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async fetchReply(message) {
    try {
      if (message.reference?.messageId === undefined || message.mentions === undefined) {
        return null;
      }

      const reference = await message.channel.messages.fetch(message.reference.messageId);

      const discUser = await message.guild.members.fetch(message.mentions.repliedUser.id);
      const mentionedUserName = discUser.nickname ?? message.mentions.repliedUser.globalName;

      if (config.discord.other.messageMode === "bot" && reference.embed !== null) {
        const name = reference.embeds[0]?.author?.name;
        if (name === undefined) {
          return mentionedUserName;
        }

        return name;
      }

      if (config.discord.other.messageMode === "minecraft" && reference.attachments !== null) {
        const name = reference.attachments.values()?.next()?.value?.name;
        if (name === undefined) {
          return mentionedUserName;
        }

        return name.split(".")[0];
      }

      if (config.discord.other.messageMode === "webhook") {
        if (reference.author.username === undefined) {
          return mentionedUserName;
        }

        return reference.author.username;
      }

      return mentionedUserName ?? null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  stripDiscordContent(message) {
    let output = message.content
      .split("\n")
      .map((part) => {
        part = part.trim();
        return part.length === 0 ? "" : part.replace(/@(everyone|here)/gi, "").trim() + " ";
      })
      .join("");

    const hasMentions = /<@|<#|<:|<a:/.test(message);
    if (hasMentions) {
      // Replace <@486155512568741900> with @DuckySoLucky
      const userMentionPattern = /<@(\d+)>/g;
      const replaceUserMention = (match, mentionedUserId) => {
        const mentionedUser = message.guild.members.cache.get(mentionedUserId);

        return `@${mentionedUser.displayName}`;
      };
      output = output.replace(userMentionPattern, replaceUserMention);

      // Replace <#1072863636596465726> with #💬・guild-chat
      const channelMentionPattern = /<#(\d+)>/g;
      const replaceChannelMention = (match, mentionedChannelId) => {
        const mentionedChannel = message.guild.channels.cache.get(mentionedChannelId);

        return `#${mentionedChannel.name}`;
      };
      output = output.replace(channelMentionPattern, replaceChannelMention);

      // Replace <:KEKW:628249422253391902> with :KEKW: || Replace <a:KEKW:628249422253391902> with :KEKW:
      const emojiMentionPattern = /<a?:(\w+):\d+>/g;
      output = output.replace(emojiMentionPattern, ":$1:");
    }

    if (message.stickers.size > 0) {
      const sticker = message.stickers.first();
      output = output ? `[${sticker.name}] ${output}` : `[${sticker.name}]`;
    }

    if (message.attachments.size > 0) {
      const attachments = [...message.attachments.values()]
        .map((attachment) => {
          const dot = attachment.name.lastIndexOf(".");
          const clean = (dot !== -1 ? attachment.name.slice(0, dot) : attachment.name).replace(/\./g, "_");
          return `[${clean}]`;
        })
        .join(" ");

      output = output ? `${attachments} ${output}` : attachments;
    }

    // Replace IP Adresses with [Content Redacted]
    const IPAddressPattern = /(?:\d{1,3}\s*\s\s*){3}\d{1,3}/g;
    output = output.replaceAll(IPAddressPattern, "[Content Redacted]");

    output = unemojify(output);

    return output;
  }

  shouldBroadcastMessage(message) {
    const isBot = message.author.bot && config.discord.channels.allowedBots.includes(message.author.id) === false ? true : false;
    const isValid = !isBot && (message.content.length > 0 || message.attachments.size > 0 || message.stickers.size > 0);
    const validChannelIds = [config.discord.channels.officerChannel, config.discord.channels.guildChatChannel, config.discord.channels.debugChannel];

    return isValid && validChannelIds.includes(message.channel.id);
  }

  getGuildMutedUsersSet() {
    const raw = String(carryDatabase.getBinding(GUILD_MUTED_USERS_KEY, "[]") || "[]");
    try {
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.map((item) => String(item).toLowerCase()) : []);
    } catch {
      return new Set();
    }
  }

  normalizeMutedKey(value) {
    return String(value || "")
      .trim()
      .replace(/[^\w]/g, "")
      .toLowerCase();
  }

  isGuildMutedFromBridge(message) {
    const mutedSet = this.getGuildMutedUsersSet();
    if (mutedSet.size === 0) return false;

    const discordId = message?.author?.id;
    const uuid = this.normalizeMutedKey(getUuidByDiscordId(discordId));
    if (uuid && mutedSet.has(uuid)) {
      return true;
    }

    const displayName = this.normalizeMutedKey(message?.member?.displayName);
    if (displayName && mutedSet.has(displayName)) {
      return true;
    }

    const username = this.normalizeMutedKey(message?.author?.username);
    if (username && mutedSet.has(username)) {
      return true;
    }

    return false;
  }

  isLinkedBridgeUser(discordId) {
    return Boolean(getUuidByDiscordId(discordId));
  }

  async sendTemporaryNotice(message, content) {
    try {
      const key = `${message.channel.id}:${message.author.id}`;
      const now = Date.now();
      const nextAllowed = this.noticeCooldown.get(key) || 0;
      if (now < nextAllowed) {
        return;
      }

      this.noticeCooldown.set(key, now + 10000);
      const sent = await message.reply({
        content: `<@${message.author.id}> ${content}`,
        allowedMentions: { users: [message.author.id], roles: [], repliedUser: false }
      });

      setTimeout(() => {
        sent.delete().catch(() => {});
      }, 8000);
    } catch {
      // ignore temporary notice failures
    }
  }
}

module.exports = MessageHandler;

