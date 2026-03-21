const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { existsSync, readFileSync, writeFileSync } = require("fs");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const { checkRequirements } = require("../commands/requirementsCommand.js");
const { getLatestProfile } = require("../../../API/functions/getLatestProfile.js");
const config = require("../../../config.json");

const JOIN_REQUEST_DATA_PATH = "data/joinRequests.json";
const PANEL_BUTTON_ID = "joinreq:create";
const PANEL_MODAL_ID = "joinreq:create:submit";

class JoinRequestManager {
  constructor(discord) {
    this.discord = discord;
    this.state = {
      version: 1,
      panelMessageId: null,
      requests: []
    };
    this.expiryInterval = null;
  }

  isEnabled() {
    return Boolean(config.discord.joinRequests?.enabled);
  }

  ensureDataFile() {
    if (!existsSync(JOIN_REQUEST_DATA_PATH)) {
      this.saveState({
        version: 1,
        panelMessageId: null,
        requests: []
      });
    }
  }

  loadState() {
    this.ensureDataFile();
    try {
      const parsed = JSON.parse(readFileSync(JOIN_REQUEST_DATA_PATH, "utf8"));
      this.state = {
        version: 1,
        panelMessageId: parsed.panelMessageId ?? null,
        requests: Array.isArray(parsed.requests) ? parsed.requests : []
      };
    } catch {
      this.state = {
        version: 1,
        panelMessageId: null,
        requests: []
      };
      this.saveState(this.state);
    }
  }

  saveState(nextState = this.state) {
    this.state = nextState;
    writeFileSync(JOIN_REQUEST_DATA_PATH, JSON.stringify(this.state, null, 2));
  }

  async initialize() {
    if (!this.isEnabled()) {
      return;
    }

    this.loadState();
    await this.reconcileExpiredRequests();
    await this.reconcileRequestMessages();
    await this.ensureRequestEntryPanel();
    if (this.expiryInterval) clearInterval(this.expiryInterval);
    this.expiryInterval = setInterval(() => {
      this.reconcileExpiredRequests().catch(() => {});
    }, 60000);
  }

  stop() {
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval);
      this.expiryInterval = null;
    }
  }

  async ensureRequestEntryPanel() {
    if (!config.discord.joinRequests?.allowDiscordSelfRequest) {
      return;
    }

    const channelId = config.discord.joinRequests?.requestEntryChannelId;
    if (!channelId) {
      return;
    }

    const channel = await this.discord.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return;
    }

    const payload = {
      embeds: [this.buildEntryPanelEmbed()],
      components: [this.buildEntryPanelRow()]
    };

    let panelMessage = null;
    const configuredMessageId = config.discord.joinRequests?.requestEntryMessageId;
    const messageId = configuredMessageId || this.state.panelMessageId;

    if (messageId) {
      panelMessage = await channel.messages.fetch(messageId).catch(() => null);
      if (panelMessage) {
        await panelMessage.edit(payload);
      }
    }

    if (!panelMessage) {
      panelMessage = await channel.send(payload);
    }

    this.state.panelMessageId = panelMessage.id;
    this.saveState();
  }

  buildEntryPanelEmbed() {
    return new EmbedBuilder()
      .setColor(3447003)
      .setTitle("Guild Join Requests")
      .setDescription("Want to join the guild? Click the button below and submit your Minecraft username.")
      .setFooter({
        text: "Use the request button to open a forum thread"
      });
  }

  buildEntryPanelRow() {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(PANEL_BUTTON_ID).setLabel("Request to Join").setStyle(ButtonStyle.Primary));
  }

  buildModeratorActionsRow(request) {
    const isTerminal = this.isTerminalStatus(request?.status);
    const isExpired = request?.status === "expired";
    const reinviteDisabled = isTerminal || !isExpired;
    const acceptDisabled = isTerminal || isExpired;
    const denyDisabled = isTerminal;

    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`joinreq:reinvite:${request.requestId}`)
        .setLabel("Reinvite")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(reinviteDisabled),
      new ButtonBuilder()
        .setCustomId(`joinreq:accept:${request.requestId}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success)
        .setDisabled(acceptDisabled),
      new ButtonBuilder().setCustomId(`joinreq:deny:${request.requestId}`).setLabel("Deny").setStyle(ButtonStyle.Danger).setDisabled(denyDisabled)
    );
  }

  isTerminalStatus(status) {
    return ["denied", "accepted_ingame"].includes(status);
  }

  isActiveStatus(status) {
    return ["pending", "accepted_discord", "expired"].includes(status);
  }

  getStatusReactionEmoji(status) {
    switch (status) {
      case "pending":
      case "expired":
        return "⚠️";
      case "denied":
        return "❌";
      case "accepted_discord":
      case "accepted_ingame":
        return "✅";
      default:
        return null;
    }
  }

  async syncStatusReaction(request, message) {
    if (!message || !this.discord?.client?.user?.id) {
      return;
    }

    const botUserId = this.discord.client.user.id;
    const managedEmojis = ["⚠️", "❌", "✅"];
    const desiredEmoji = this.getStatusReactionEmoji(request?.status);

    for (const emoji of managedEmojis) {
      if (emoji === desiredEmoji) continue;
      const reaction = message.reactions?.cache?.get(emoji);
      if (reaction) {
        await reaction.users.remove(botUserId).catch(() => {});
      }
    }

    if (!desiredEmoji) {
      return;
    }

    const desiredReaction = message.reactions?.cache?.get(desiredEmoji);
    if (!desiredReaction?.users?.cache?.has(botUserId)) {
      await message.react(desiredEmoji).catch(() => {});
    }
  }

  canModerate(member) {
    const roles = config.discord.joinRequests?.moderatorRoleIds ?? [];
    if (!Array.isArray(roles) || roles.length === 0) {
      return false;
    }

    const memberRoles = member?.roles?.cache?.map((role) => role.id) ?? [];
    return memberRoles.some((roleId) => roles.includes(roleId));
  }

  normalizeUsername(username) {
    return String(username || "").trim();
  }

  buildSkyCryptLink(request, profileName = "") {
    const username = encodeURIComponent(request?.username || "");
    const preferredProfile = String(profileName || request?.requirementsSnapshot?.skyblockProfile || "").trim();
    if (preferredProfile) {
      return `https://sky.shiiyu.moe/stats/${username}/${encodeURIComponent(preferredProfile)}`;
    }
    return `https://sky.shiiyu.moe/stats/${username}`;
  }

  async resolveSkyCryptLink(request) {
    const fromSnapshot = this.buildSkyCryptLink(request);
    if (String(request?.requirementsSnapshot?.skyblockProfile || "").trim()) {
      return fromSnapshot;
    }

    const withTimeout = (promise, ms = 2000) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms))
      ]);

    try {
      const latest = await withTimeout(getLatestProfile(request?.uuid || request?.username), 2000);
      if (!latest) return fromSnapshot;
      const profileName = latest?.profileData?.cute_name || "";
      return this.buildSkyCryptLink(request, profileName);
    } catch {
      return fromSnapshot;
    }
  }

  getRequestById(requestId) {
    return this.state.requests.find((request) => request.requestId === requestId);
  }

  getActiveRequestByUsername(username) {
    const normalized = this.normalizeUsername(username).toLowerCase();
    return this.state.requests.find((request) => request.username.toLowerCase() === normalized && this.isActiveStatus(request.status));
  }

  toTimestamp(date) {
    return Math.floor(new Date(date).getTime() / 1000);
  }

  getStatusLabel(status) {
    switch (status) {
      case "pending":
        return "🟡 Pending";
      case "accepted_discord":
        return "🟢 Accepted via Discord";
      case "accepted_ingame":
        return "✅ Accepted In-game";
      case "denied":
        return "❌ Denied";
      case "expired":
        return "⚠️ Expired";
      default:
        return "Unknown";
    }
  }

  getConfiguredStatusTagId(status) {
    const statusTagIds = config.discord.joinRequests?.statusTagIds;
    if (!statusTagIds || typeof statusTagIds !== "object") {
      return null;
    }

    return statusTagIds[status] || null;
  }

  getFallbackStatusTagNames(status) {
    switch (status) {
      case "pending":
        return ["Pending"];
      case "accepted_discord":
        return ["Accepted Discord", "Accepted via Discord", "Accepted"];
      case "accepted_ingame":
        return ["Accepted In-game", "Accepted Ingame", "Accepted"];
      case "denied":
        return ["Denied", "Rejected"];
      case "expired":
        return ["Expired", "Timed Out", "Timeout"];
      default:
        return [];
    }
  }

  resolveStatusTagId(status, forumChannel) {
    if (!forumChannel || !Array.isArray(forumChannel.availableTags)) {
      return null;
    }

    const configuredTagId = this.getConfiguredStatusTagId(status);
    if (configuredTagId) {
      const found = forumChannel.availableTags.find((tag) => tag.id === configuredTagId);
      if (found) {
        return found.id;
      }
    }

    const fallbackNames = this.getFallbackStatusTagNames(status).map((name) => name.toLowerCase());
    const byName = forumChannel.availableTags.find((tag) => fallbackNames.includes((tag.name || "").toLowerCase()));
    return byName?.id || null;
  }

  async syncThreadStatusTag(request, thread, forumChannel = null) {
    if (!thread) {
      return;
    }

    const forum = forumChannel || (await this.discord.client.channels.fetch(thread.parentId).catch(() => null));
    if (!forum || forum.type !== ChannelType.GuildForum) {
      return;
    }

    const statusTagId = this.resolveStatusTagId(request.status, forum);
    if (!statusTagId) {
      return;
    }

    const currentTags = Array.isArray(thread.appliedTags) ? thread.appliedTags : [];
    if (currentTags.length === 1 && currentTags[0] === statusTagId) {
      return;
    }

    await thread.setAppliedTags([statusTagId]).catch(() => {});
  }

  async buildRequestEmbed(request) {
    const status = this.getStatusLabel(request.status);
    const baseEmbed = new EmbedBuilder()
      .setColor(request.status === "denied" ? 15548997 : 3447003)
      .setTitle(`${request.username} Join Request`)
      .setThumbnail(`https://mc-heads.net/avatar/${request.username}`)
      .setDescription(`Guild join request for **${request.username}**`)
      .addFields(
        { name: "Status", value: status, inline: true },
        { name: "Source", value: request.source === "discord_button" ? "Discord Button" : "In-game", inline: true },
        {
          name: "Accept Timeout",
          value: `<t:${this.toTimestamp(request.expiresAt)}:R> (<t:${this.toTimestamp(request.expiresAt)}:f>)`,
          inline: false
        }
      )
      .setFooter({ text: `Request ID: ${request.requestId}` })
      .setTimestamp(new Date(request.createdAt));

    if (request.note) {
      baseEmbed.addFields({ name: "Applicant Note", value: request.note.slice(0, 1024), inline: false });
    }

    const lastAcceptedDiscord = [...request.actions].reverse().find((action) => action.action === "accepted_discord");
    const lastAcceptedIngame = [...request.actions].reverse().find((action) => action.action === "accepted_ingame");
    const lastDenied = [...request.actions].reverse().find((action) => action.action === "denied");

    if (lastAcceptedDiscord) {
      baseEmbed.addFields({
        name: "Accepted via Discord",
        value: `by <@${lastAcceptedDiscord.actorDiscordId}> at <t:${this.toTimestamp(lastAcceptedDiscord.timestamp)}:f>`,
        inline: false
      });
    } else if (lastAcceptedIngame) {
      baseEmbed.addFields({
        name: "Accepted In-game",
        value: `detected at <t:${this.toTimestamp(lastAcceptedIngame.timestamp)}:f>`,
        inline: false
      });
    }

    if (lastDenied) {
      baseEmbed.addFields({
        name: "Denied",
        value: `by <@${lastDenied.actorDiscordId}> at <t:${this.toTimestamp(lastDenied.timestamp)}:f>`,
        inline: false
      });
    }

    const reqData = request.requirementsSnapshot;
    if (reqData) {
      baseEmbed.addFields(
        { name: "Bedwars", value: `Stars: ${reqData.bwLevel}\nFKDR: ${reqData.bwFKDR}`, inline: true },
        { name: "Skywars", value: `Stars: ${reqData.swLevel}\nKDR: ${reqData.swKDR}`, inline: true },
        { name: "Duels", value: `Wins: ${reqData.duelsWins}\nWLR: ${reqData.dWLR}`, inline: true },
        { name: "SkyBlock Level", value: `${reqData.skyblockLevel}`, inline: true }
      );
    }

    return baseEmbed;
  }

  makeRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getExpiryDate() {
    const timeoutMinutes = Number(config.discord.joinRequests?.requestTimeoutMinutes ?? 5);
    return new Date(Date.now() + Math.max(1, timeoutMinutes) * 60 * 1000).toISOString();
  }

  async createRequest({ username, uuid, source, requestedByDiscordId = null, requestedByDiscordTag = null, note = "" }) {
    const normalizedUsername = this.normalizeUsername(username);
    if (!normalizedUsername) {
      throw new Error("Invalid username");
    }

    const existing = this.getActiveRequestByUsername(normalizedUsername);
    if (existing) {
      return { request: existing, created: false };
    }

    const forumChannelId = config.discord.joinRequests?.forumChannelId;
    const forum = await this.discord.client.channels.fetch(forumChannelId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      throw new Error("Forum channel is not configured correctly.");
    }

    const request = {
      requestId: this.makeRequestId(),
      source,
      username: normalizedUsername,
      uuid,
      note: note?.trim() ?? "",
      requestedByDiscordId,
      requestedByDiscordTag,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: this.getExpiryDate(),
      reinviteCount: 0,
      threadId: null,
      messageId: null,
      requirementsSnapshot: null,
      actions: [
        {
          action: "created",
          actorDiscordId: requestedByDiscordId,
          actorTag: requestedByDiscordTag,
          timestamp: new Date().toISOString(),
          note: source
        }
      ]
    };

    try {
      request.requirementsSnapshot = await checkRequirements(uuid);
    } catch {
      request.requirementsSnapshot = null;
    }

    const embed = await this.buildRequestEmbed(request);
    const mentionText = config.discord.joinRequests?.mentionOnCreate || "";
    const skycryptLink = await this.resolveSkyCryptLink(request);
    request.skycryptLink = skycryptLink;
    const initialStatusTagId = this.resolveStatusTagId(request.status, forum);
    const thread = await forum.threads.create({
      name: `${request.username}_Join_Request`,
      appliedTags: initialStatusTagId ? [initialStatusTagId] : [],
      message: {
        content: [mentionText, `Guild join request for **${request.username}**`].filter(Boolean).join("\n")
      }
    });

    const requestMessage = await thread
      .send({
        embeds: [embed],
        components: [this.buildModeratorActionsRow(request)]
      })
      .catch(() => null);

    await thread.send(`<${skycryptLink}>`).catch(() => {});

    const starterMessage = requestMessage || (await thread.fetchStarterMessage().catch(() => null));
    request.threadId = thread.id;
    request.messageId = starterMessage?.id ?? null;
    if (starterMessage) {
      await this.syncStatusReaction(request, starterMessage);
    }

    this.state.requests.push(request);
    this.saveState();

    return { request, created: true };
  }

  async updateRequestMessage(request) {
    if (!request.threadId || !request.messageId) {
      return;
    }

    const thread = await this.discord.client.channels.fetch(request.threadId).catch(() => null);
    if (!thread || thread.type !== ChannelType.PublicThread) {
      return;
    }

    const message = await thread.messages.fetch(request.messageId).catch(() => null);
    if (!message) {
      return;
    }

    const embed = await this.buildRequestEmbed(request);
    await message.edit({
      embeds: [embed],
      components: [this.buildModeratorActionsRow(request)]
    });
    await this.syncStatusReaction(request, message);
    await this.syncThreadStatusTag(request, thread);
  }

  async reconcileExpiredRequests() {
    const now = Date.now();
    let changed = false;
    for (const request of this.state.requests) {
      if (request.status === "pending" && new Date(request.expiresAt).getTime() <= now) {
        request.status = "expired";
        request.actions.push({
          action: "expired",
          actorDiscordId: null,
          actorTag: "system",
          timestamp: new Date().toISOString(),
          note: "Timed out without action"
        });
        changed = true;
        await this.updateRequestMessage(request);
      }
    }

    if (changed) {
      this.saveState();
    }
  }

  async reconcileRequestMessages() {
    for (const request of this.state.requests) {
      if (this.isActiveStatus(request.status) || this.isTerminalStatus(request.status)) {
        await this.updateRequestMessage(request);
      }
    }
  }

  async onIngameRequest(username) {
    if (!this.isEnabled()) {
      return null;
    }

    const uuid = await getUUID(username);
    return this.createRequest({
      username,
      uuid,
      source: "ingame"
    });
  }

  async onIngameAccepted(username) {
    if (!this.isEnabled() || !config.discord.joinRequests?.trackIngameAcceptance) {
      return false;
    }

    const target = this.state.requests
      .filter((request) => request.username.toLowerCase() === username.toLowerCase() && ["pending", "expired"].includes(request.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!target) {
      return false;
    }

    target.status = "accepted_ingame";
    target.actions.push({
      action: "accepted_ingame",
      actorDiscordId: null,
      actorTag: "system",
      timestamp: new Date().toISOString(),
      note: "Detected guild join event"
    });

    this.saveState();
    await this.updateRequestMessage(target);
    return true;
  }

  async handleCreateButton(interaction) {
    if (!this.isEnabled() || !config.discord.joinRequests?.allowDiscordSelfRequest) {
      return interaction.reply({ content: "Join requests are currently disabled.", ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId(PANEL_MODAL_ID).setTitle("Guild Join Request");
    const usernameInput = new TextInputBuilder()
      .setCustomId("username")
      .setLabel("Minecraft Username")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(16);
    const noteInput = new TextInputBuilder()
      .setCustomId("note")
      .setLabel("Optional Note")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(300);

    modal.addComponents(new ActionRowBuilder().addComponents(usernameInput), new ActionRowBuilder().addComponents(noteInput));
    return interaction.showModal(modal);
  }

  async handleCreateModal(interaction) {
    if (!this.isEnabled() || !config.discord.joinRequests?.allowDiscordSelfRequest) {
      return interaction.reply({ content: "Join requests are currently disabled.", ephemeral: true });
    }

    const username = this.normalizeUsername(interaction.fields.getTextInputValue("username"));
    const note = interaction.fields.getTextInputValue("note") || "";
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      return interaction.reply({ content: "Invalid Minecraft username format.", ephemeral: true });
    }

    let uuid = "";
    try {
      uuid = await getUUID(username);
    } catch {
      return interaction.reply({ content: "Could not resolve UUID for that username.", ephemeral: true });
    }

    const result = await this.createRequest({
      username,
      uuid,
      source: "discord_button",
      requestedByDiscordId: interaction.user.id,
      requestedByDiscordTag: interaction.user.tag,
      note
    });

    const link = result.request.threadId ? `<#${result.request.threadId}>` : "thread";
    if (result.created) {
      return interaction.reply({ content: `Your join request has been created: ${link}`, ephemeral: true });
    }

    return interaction.reply({ content: `You already have an active request: ${link}`, ephemeral: true });
  }

  async handleModeratorAction({ action, requestId, interaction }) {
    const request = this.getRequestById(requestId);
    if (!request) {
      return interaction.reply({ content: "Request not found.", ephemeral: true });
    }

    if (!this.canModerate(interaction.member)) {
      return interaction.reply({ content: "You do not have permission to manage join requests.", ephemeral: true });
    }

    if (this.isTerminalStatus(request.status)) {
      return interaction.reply({ content: `Request is already closed with status: ${this.getStatusLabel(request.status)}.`, ephemeral: true });
    }

    if (action === "accept") {
      if (request.status === "expired") {
        return interaction.reply({ content: "This request timed out. Reinvite first, then accept.", ephemeral: true });
      }
      bot.chat(`/g accept ${request.username}`);
      request.status = "accepted_discord";
      request.actions.push({
        action: "accepted_discord",
        actorDiscordId: interaction.user.id,
        actorTag: interaction.user.tag,
        timestamp: new Date().toISOString(),
        note: "Accepted from Discord"
      });
      this.saveState();
      await this.updateRequestMessage(request);
      return interaction.reply({ content: `Accepted **${request.username}** via Discord.`, ephemeral: true });
    }

    if (action === "deny") {
      request.status = "denied";
      request.actions.push({
        action: "denied",
        actorDiscordId: interaction.user.id,
        actorTag: interaction.user.tag,
        timestamp: new Date().toISOString(),
        note: "Denied from Discord"
      });
      this.saveState();
      await this.updateRequestMessage(request);
      return interaction.reply({ content: `Denied **${request.username}**.`, ephemeral: true });
    }

    if (action === "reinvite") {
      if (request.status !== "expired") {
        return interaction.reply({ content: "Reinvite is only available after timeout.", ephemeral: true });
      }
      bot.chat(`/g invite ${request.username}`);
      request.reinviteCount += 1;
      request.expiresAt = this.getExpiryDate();
      request.status = "pending";
      request.actions.push({
        action: "reinvited",
        actorDiscordId: interaction.user.id,
        actorTag: interaction.user.tag,
        timestamp: new Date().toISOString(),
        note: `Reinvite #${request.reinviteCount}`
      });
      this.saveState();
      await this.updateRequestMessage(request);
      return interaction.reply({ content: `Reinvited **${request.username}** and reset timeout.`, ephemeral: true });
    }

    return interaction.reply({ content: "Unknown action.", ephemeral: true });
  }

  static isJoinRequestComponent(customId) {
    return typeof customId === "string" && (customId === PANEL_BUTTON_ID || customId.startsWith("joinreq:"));
  }

  static parseActionCustomId(customId) {
    const parts = customId.split(":");
    if (parts.length !== 3) {
      return null;
    }

    const [, action, requestId] = parts;
    if (!["accept", "deny", "reinvite"].includes(action)) {
      return null;
    }

    return { action, requestId };
  }
}

module.exports = {
  JoinRequestManager,
  PANEL_BUTTON_ID,
  PANEL_MODAL_ID
};
