const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const ms = require("ms");
const hypixel = require("../../contracts/API/HypixelRebornAPI.js");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const config = require("../../../config.json");

const STATE_PATH = "data/giveaways.json";
const GUILD_CACHE_TTL_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

class GiveawayService {
  constructor(options = {}) {
    this.statePath = options.statePath || STATE_PATH;
    this.now = options.now || (() => Date.now());
    this.state = null;
    this.client = null;
    this.timers = new Map();
    this.guildCache = null;
  }

  getDefaultState() {
    return {
      version: 1,
      settings: {
        starterMode: "everyone",
        allowedIngameStarterRanks: [],
        defaultChannelId: null
      },
      activeGiveaways: [],
      usedIds: []
    };
  }

  ensureDataFile() {
    if (!existsSync("data")) {
      mkdirSync("data", { recursive: true });
    }

    if (!existsSync(this.statePath)) {
      writeFileSync(this.statePath, JSON.stringify(this.getDefaultState(), null, 2));
    }
  }

  normalizeState(state) {
    const defaults = this.getDefaultState();
    const normalized = {
      version: 1,
      settings: {
        starterMode: state?.settings?.starterMode === "bridge_admin_only" ? "bridge_admin_only" : defaults.settings.starterMode,
        allowedIngameStarterRanks: Array.isArray(state?.settings?.allowedIngameStarterRanks)
          ? state.settings.allowedIngameStarterRanks.filter((rank) => typeof rank === "string" && rank.trim().length > 0).map((rank) => rank.trim())
          : [],
        defaultChannelId: typeof state?.settings?.defaultChannelId === "string" && state.settings.defaultChannelId.length > 0 ? state.settings.defaultChannelId : null
      },
      activeGiveaways: Array.isArray(state?.activeGiveaways)
        ? state.activeGiveaways
            .map((entry) => this.normalizeGiveaway(entry))
            .filter((entry) => entry && Number.isFinite(entry.endsAt) && entry.endsAt > this.now())
        : [],
      usedIds: Array.isArray(state?.usedIds)
        ? [...new Set(state.usedIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
        : []
    };

    const activeIds = new Set(normalized.activeGiveaways.map((entry) => entry.id));
    normalized.usedIds = [...new Set([...normalized.usedIds, ...activeIds])].sort((a, b) => a - b);
    return normalized;
  }

  normalizeGiveaway(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const id = Number(entry.id);
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    const prize = String(entry.prize || "").trim();
    if (!prize) {
      return null;
    }

    const createdAt = Number(entry.createdAt) || this.now();
    const endsAt = Number(entry.endsAt);
    const winnerCount = Math.max(1, Number(entry.winnerCount) || 1);
    const discordEntrants = Array.isArray(entry.entrants?.discord)
      ? entry.entrants.discord
          .map((user) => ({
            id: String(user?.id || "").trim(),
            tag: String(user?.tag || "").trim() || null
          }))
          .filter((user) => user.id.length > 0)
      : [];
    const ingameEntrants = Array.isArray(entry.entrants?.ingame)
      ? entry.entrants.ingame
          .map((user) => ({
            username: String(user?.username || "").trim()
          }))
          .filter((user) => user.username.length > 0)
      : [];

    return {
      id,
      prize,
      createdAt,
      endsAt,
      winnerCount,
      requiredRoleId: entry.requiredRoleId ? String(entry.requiredRoleId) : null,
      channelId: String(entry.channelId || "").trim() || null,
      messageId: String(entry.messageId || "").trim() || null,
      createdBy: {
        source: String(entry.createdBy?.source || "unknown"),
        username: entry.createdBy?.username ? String(entry.createdBy.username) : null,
        discordId: entry.createdBy?.discordId ? String(entry.createdBy.discordId) : null
      },
      entrants: {
        discord: this.uniqueDiscordEntrants(discordEntrants),
        ingame: this.uniqueIngameEntrants(ingameEntrants)
      }
    };
  }

  uniqueDiscordEntrants(entries) {
    const seen = new Set();
    const output = [];
    for (const entry of entries) {
      const id = String(entry.id || "").trim();
      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      output.push({
        id,
        tag: entry.tag || null
      });
    }

    return output;
  }

  uniqueIngameEntrants(entries) {
    const seen = new Set();
    const output = [];
    for (const entry of entries) {
      const username = String(entry.username || "").trim();
      const key = username.toLowerCase();
      if (!username || seen.has(key)) {
        continue;
      }

      seen.add(key);
      output.push({ username });
    }

    return output;
  }

  loadState() {
    if (this.state) {
      return this.state;
    }

    this.ensureDataFile();
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      this.state = this.normalizeState(parsed);
    } catch {
      this.state = this.getDefaultState();
      this.saveState();
    }

    return this.state;
  }

  saveState() {
    const state = this.loadState();
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  initialize(client) {
    this.client = client || this.client;
    this.loadState();
    this.rescheduleAll();
  }

  shutdown() {
    for (const timeout of this.timers.values()) {
      clearTimeout(timeout);
    }

    this.timers.clear();
  }

  getSettings() {
    const state = this.loadState();
    return {
      ...state.settings,
      allowedIngameStarterRanks: [...state.settings.allowedIngameStarterRanks]
    };
  }

  updateSettings(next) {
    const state = this.loadState();
    if (next?.starterMode) {
      state.settings.starterMode = next.starterMode === "bridge_admin_only" ? "bridge_admin_only" : "everyone";
    }

    if (Object.prototype.hasOwnProperty.call(next || {}, "allowedIngameStarterRanks")) {
      state.settings.allowedIngameStarterRanks = Array.isArray(next.allowedIngameStarterRanks)
        ? next.allowedIngameStarterRanks.filter((rank) => typeof rank === "string" && rank.trim().length > 0).map((rank) => rank.trim())
        : [];
    }

    if (Object.prototype.hasOwnProperty.call(next || {}, "defaultChannelId")) {
      state.settings.defaultChannelId = next.defaultChannelId ? String(next.defaultChannelId) : null;
    }

    this.saveState();
    return this.getSettings();
  }

  parseDuration(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }

    const parsed = ms(value.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return parsed;
  }

  allocateId() {
    const state = this.loadState();
    const used = new Set(state.usedIds);
    let id = 1;
    while (used.has(id)) {
      id += 1;
    }

    state.usedIds.push(id);
    state.usedIds.sort((a, b) => a - b);
    return id;
  }

  freeId(id) {
    const state = this.loadState();
    state.usedIds = state.usedIds.filter((value) => value !== id);
  }

  getActiveGiveaways() {
    return [...this.loadState().activeGiveaways].sort((a, b) => a.id - b.id);
  }

  getGiveaway(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return null;
    }

    return this.loadState().activeGiveaways.find((entry) => entry.id === numericId) || null;
  }

  getEntrantCount(giveaway) {
    return (giveaway?.entrants?.discord?.length || 0) + (giveaway?.entrants?.ingame?.length || 0);
  }

  formatRemaining(endsAt) {
    const remaining = Math.max(0, endsAt - this.now());
    if (remaining <= 0) {
      return "ended";
    }

    return ms(remaining, { long: true });
  }

  buildGiveawayEmbed(giveaway, options = {}) {
    const entrants = this.getEntrantCount(giveaway);
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`Giveaway #${giveaway.id}`)
      .setDescription(`Prize: **${giveaway.prize}**`)
      .addFields(
        { name: "Winners", value: `${giveaway.winnerCount}`, inline: true },
        { name: "Entrants", value: `${entrants}`, inline: true },
        { name: "Ends", value: `<t:${Math.floor(giveaway.endsAt / 1000)}:R>`, inline: true }
      )
      .setFooter({
        text: giveaway.requiredRoleId ? `Role required to join: ${giveaway.requiredRoleId}` : "No role required to join"
      })
      .setTimestamp(new Date(giveaway.createdAt));

    if (options.winnerText) {
      embed.addFields({
        name: "Winner(s)",
        value: options.winnerText
      });
      embed.setColor(0x2ecc71);
    }

    if (options.endedNoEntrants) {
      embed.addFields({
        name: "Result",
        value: "No entrants joined this giveaway."
      });
      embed.setColor(0xe67e22);
    }

    return embed;
  }

  buildComponents(active = true, giveawayId = null) {
    if (!active) {
      return [];
    }

    if (!Number.isInteger(Number(giveawayId)) || Number(giveawayId) <= 0) {
      return [];
    }

    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`giveaway:join:${giveawayId}`).setLabel("Join").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`giveaway:leave:${giveawayId}`).setLabel("Leave").setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  async resolveChannel(channelId) {
    if (!this.client || !channelId) {
      return null;
    }

    return this.client.channels.cache.get(channelId) || this.client.channels.fetch(channelId).catch(() => null);
  }

  async postGiveawayMessage(giveaway) {
    const channel = await this.resolveChannel(giveaway.channelId);
    if (!channel || typeof channel.send !== "function") {
      throw new Error("Giveaway channel not found.");
    }

    const message = await channel.send({
      embeds: [this.buildGiveawayEmbed(giveaway)],
      components: this.buildComponents(true, giveaway.id)
    });

    giveaway.messageId = message.id;
    this.saveState();
  }

  async updateGiveawayMessage(giveaway) {
    if (!giveaway?.channelId || !giveaway?.messageId) {
      return;
    }

    const channel = await this.resolveChannel(giveaway.channelId);
    if (!channel) {
      return;
    }

    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (!message) {
      return;
    }

    await message.edit({
      embeds: [this.buildGiveawayEmbed(giveaway)],
      components: this.buildComponents(true, giveaway.id)
    });
  }

  async postEndedGiveawayMessage(giveaway, winners) {
    const channel = await this.resolveChannel(giveaway.channelId);
    if (!channel || typeof channel.send !== "function") {
      return;
    }

    if (!winners.length) {
      await channel.send({
        embeds: [this.buildGiveawayEmbed(giveaway, { endedNoEntrants: true })]
      });
      return;
    }

    const winnerText = winners.map((winner) => winner.display).join(", ");
    await channel.send({
      embeds: [this.buildGiveawayEmbed(giveaway, { winnerText })]
    });
  }

  sendGuildAnnouncement(message) {
    if (!global.bot?._client?.chat) {
      return;
    }

    bot.chat(`/gc ${message}`);
  }

  async createGiveaway({ prize, durationMs, winnerCount = 1, channelId, requiredRoleId = null, createdBy = {} }) {
    const cleanPrize = String(prize || "").trim();
    if (!cleanPrize) {
      throw new Error("Prize is required.");
    }

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("Invalid giveaway duration.");
    }

    if (!channelId) {
      throw new Error("Giveaway channel is not configured.");
    }

    const state = this.loadState();
    const id = this.allocateId();
    const now = this.now();
    const giveaway = {
      id,
      prize: cleanPrize,
      createdAt: now,
      endsAt: now + Math.floor(durationMs),
      winnerCount: Math.max(1, Number(winnerCount) || 1),
      requiredRoleId: requiredRoleId ? String(requiredRoleId) : null,
      channelId: String(channelId),
      messageId: null,
      createdBy: {
        source: createdBy.source || "unknown",
        username: createdBy.username || null,
        discordId: createdBy.discordId || null
      },
      entrants: {
        discord: [],
        ingame: []
      }
    };

    state.activeGiveaways.push(giveaway);
    this.saveState();
    await this.postGiveawayMessage(giveaway);
    this.scheduleEnd(giveaway.id);
    this.sendGuildAnnouncement(`Giveaway #${giveaway.id} started: ${giveaway.prize}. Join with !joingiveaway "${giveaway.id}"`);
    return giveaway;
  }

  isBridgeAdmin({ discordUserId, memberRoleIds = [] }) {
    if (!discordUserId) {
      return false;
    }

    if (config.discord.commands.users.includes(discordUserId)) {
      return true;
    }

    return memberRoleIds.includes(config.discord.commands.commandRole);
  }

  isDiscordGuildMember(member) {
    if (!member?.user?.id) {
      return false;
    }

    if (config.discord.commands.users.includes(member.user.id)) {
      return true;
    }

    const guildRoleId = config.verification?.roles?.guildMember?.roleId;
    if (typeof guildRoleId === "string" && guildRoleId.trim().length > 0) {
      const roles = member.roles?.cache?.map((role) => role.id) || [];
      return roles.includes(guildRoleId);
    }

    return true;
  }

  async getGuildMembersSnapshot() {
    if (this.guildCache && this.guildCache.expiresAt > this.now()) {
      return this.guildCache.value;
    }

    if (!global.bot?._client?.chat) {
      throw new Error("Bot doesn't seem to be connected to Hypixel.");
    }

    const guild = await hypixel.getGuild("player", bot.username, { noCaching: true, noCacheCheck: true });
    const members = Array.isArray(guild?.members) ? guild.members : [];
    const byUuid = new Map();
    for (const member of members) {
      const uuid = String(member?.uuid || "").replaceAll("-", "").toLowerCase();
      if (!uuid) {
        continue;
      }

      byUuid.set(uuid, {
        uuid,
        rank: member.rank || "Member"
      });
    }

    this.guildCache = {
      value: byUuid,
      expiresAt: this.now() + GUILD_CACHE_TTL_MS
    };
    return byUuid;
  }

  async getIngameGuildMembership(username) {
    const clean = String(username || "").trim();
    if (!clean) {
      return null;
    }

    const uuid = await getUUID(clean).catch(() => null);
    if (!uuid) {
      return null;
    }

    const normalizedUuid = String(uuid).replaceAll("-", "").toLowerCase();
    const members = await this.getGuildMembersSnapshot();
    const entry = members.get(normalizedUuid);
    if (!entry) {
      return null;
    }

    return {
      username: clean,
      rank: entry.rank,
      uuid: normalizedUuid
    };
  }

  async canStartFromIngame(username) {
    const membership = await this.getIngameGuildMembership(username);
    if (!membership) {
      return {
        ok: false,
        reason: "Only guild members can start giveaways."
      };
    }

    const settings = this.getSettings();
    const allowedRanks = settings.allowedIngameStarterRanks;
    if (allowedRanks.length > 0 && !allowedRanks.includes(membership.rank)) {
      return {
        ok: false,
        reason: `You need one of these guild ranks: ${allowedRanks.join(", ")}`
      };
    }

    return { ok: true, rank: membership.rank };
  }

  canStartFromDiscord(member) {
    if (!this.isDiscordGuildMember(member)) {
      return {
        ok: false,
        reason: "You need to be a guild member to start giveaways."
      };
    }

    const settings = this.getSettings();
    if (settings.starterMode === "bridge_admin_only") {
      const roleIds = member.roles?.cache?.map((role) => role.id) || [];
      const admin = this.isBridgeAdmin({
        discordUserId: member.user.id,
        memberRoleIds: roleIds
      });

      if (!admin) {
        return {
          ok: false,
          reason: "Only bridge admins can start giveaways right now."
        };
      }
    }

    return { ok: true };
  }

  addDiscordEntrant(giveaway, user) {
    const existing = giveaway.entrants.discord.find((entry) => entry.id === user.id);
    if (existing) {
      return false;
    }

    giveaway.entrants.discord.push({
      id: user.id,
      tag: user.tag || null
    });
    return true;
  }

  removeDiscordEntrant(giveaway, userId) {
    const sizeBefore = giveaway.entrants.discord.length;
    giveaway.entrants.discord = giveaway.entrants.discord.filter((entry) => entry.id !== userId);
    return giveaway.entrants.discord.length !== sizeBefore;
  }

  addIngameEntrant(giveaway, username) {
    const key = String(username || "").toLowerCase();
    if (!key) {
      return false;
    }

    if (giveaway.entrants.ingame.some((entry) => entry.username.toLowerCase() === key)) {
      return false;
    }

    giveaway.entrants.ingame.push({ username });
    return true;
  }

  removeIngameEntrant(giveaway, username) {
    const key = String(username || "").toLowerCase();
    const sizeBefore = giveaway.entrants.ingame.length;
    giveaway.entrants.ingame = giveaway.entrants.ingame.filter((entry) => entry.username.toLowerCase() !== key);
    return giveaway.entrants.ingame.length !== sizeBefore;
  }

  async joinFromDiscord({ giveawayId, member }) {
    const giveaway = this.getGiveaway(giveawayId);
    if (!giveaway) {
      return { ok: false, reason: "Giveaway not found or already ended." };
    }

    if (!this.isDiscordGuildMember(member)) {
      return { ok: false, reason: "You need to be a guild member to join this giveaway." };
    }

    if (giveaway.requiredRoleId) {
      const memberRoles = member.roles?.cache?.map((role) => role.id) || [];
      if (!memberRoles.includes(giveaway.requiredRoleId)) {
        return { ok: false, reason: "You don't have the required role for this giveaway." };
      }
    }

    const changed = this.addDiscordEntrant(giveaway, member.user);
    if (!changed) {
      return { ok: false, reason: "You are already joined." };
    }

    this.saveState();
    await this.updateGiveawayMessage(giveaway);
    return { ok: true, giveaway };
  }

  async leaveFromDiscord({ giveawayId, userId }) {
    const giveaway = this.getGiveaway(giveawayId);
    if (!giveaway) {
      return { ok: false, reason: "Giveaway not found or already ended." };
    }

    const changed = this.removeDiscordEntrant(giveaway, userId);
    if (!changed) {
      return { ok: false, reason: "You are not joined in this giveaway." };
    }

    this.saveState();
    await this.updateGiveawayMessage(giveaway);
    return { ok: true, giveaway };
  }

  async joinFromIngame({ giveawayId, username }) {
    const giveaway = this.getGiveaway(giveawayId);
    if (!giveaway) {
      return { ok: false, reason: "Giveaway not found or already ended." };
    }

    const membership = await this.getIngameGuildMembership(username);
    if (!membership) {
      return { ok: false, reason: "Only guild members can join giveaways." };
    }

    if (giveaway.requiredRoleId) {
      return { ok: false, reason: "This giveaway can only be joined on Discord due to role requirements." };
    }

    const changed = this.addIngameEntrant(giveaway, membership.username);
    if (!changed) {
      return { ok: false, reason: "You are already joined." };
    }

    this.saveState();
    await this.updateGiveawayMessage(giveaway);
    return { ok: true, giveaway };
  }

  async leaveFromIngame({ giveawayId, username }) {
    const giveaway = this.getGiveaway(giveawayId);
    if (!giveaway) {
      return { ok: false, reason: "Giveaway not found or already ended." };
    }

    const changed = this.removeIngameEntrant(giveaway, username);
    if (!changed) {
      return { ok: false, reason: "You are not joined in this giveaway." };
    }

    this.saveState();
    await this.updateGiveawayMessage(giveaway);
    return { ok: true, giveaway };
  }

  pickWinners(giveaway) {
    const pool = [
      ...giveaway.entrants.discord.map((entry) => ({ type: "discord", value: entry.id, display: `<@${entry.id}>` })),
      ...giveaway.entrants.ingame.map((entry) => ({ type: "ingame", value: entry.username, display: `\`${entry.username}\`` }))
    ];

    if (pool.length === 0) {
      return [];
    }

    const count = Math.min(giveaway.winnerCount, pool.length);
    const picked = [];
    const copy = [...pool];
    for (let i = 0; i < count; i += 1) {
      const index = Math.floor(Math.random() * copy.length);
      picked.push(copy[index]);
      copy.splice(index, 1);
    }

    return picked;
  }

  async endGiveaway(id) {
    const state = this.loadState();
    const giveawayIndex = state.activeGiveaways.findIndex((entry) => entry.id === id);
    if (giveawayIndex === -1) {
      this.clearTimer(id);
      return;
    }

    const giveaway = state.activeGiveaways[giveawayIndex];
    this.clearTimer(id);
    const winners = this.pickWinners(giveaway);

    state.activeGiveaways.splice(giveawayIndex, 1);
    this.freeId(id);
    this.saveState();

    await this.postEndedGiveawayMessage(giveaway, winners);
    if (!winners.length) {
      this.sendGuildAnnouncement(`Giveaway #${id} ended with no entrants.`);
      return;
    }

    this.sendGuildAnnouncement(`Giveaway #${id} ended. Winner(s): ${winners.map((winner) => winner.display).join(", ")}`);
  }

  clearTimer(id) {
    const timeout = this.timers.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timers.delete(id);
    }
  }

  scheduleEnd(id) {
    const giveaway = this.getGiveaway(id);
    if (!giveaway) {
      this.clearTimer(id);
      return;
    }

    this.clearTimer(id);
    const delay = Math.max(0, giveaway.endsAt - this.now());
    if (delay > MAX_TIMEOUT_MS) {
      const timeout = setTimeout(() => this.scheduleEnd(id), MAX_TIMEOUT_MS);
      if (typeof timeout.unref === "function") {
        timeout.unref();
      }

      this.timers.set(id, timeout);
      return;
    }

    const timeout = setTimeout(() => {
      this.endGiveaway(id).catch((error) => console.error(error));
    }, delay);

    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    this.timers.set(id, timeout);
  }

  rescheduleAll() {
    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }

    for (const giveaway of this.getActiveGiveaways()) {
      this.scheduleEnd(giveaway.id);
    }
  }
}

const giveawayService = new GiveawayService();

module.exports = giveawayService;
module.exports.GiveawayService = GiveawayService;
