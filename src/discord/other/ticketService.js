const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { readFileSync } = require("fs");
const config = require("../../../config.json");

const TICKET_CREATE_PREFIX = "ticket:create:";
const TICKET_ACTION_PREFIX = "ticket:action:";
const TICKET_MODAL_PREFIX = "ticket:modal:";
const CARRY_TAG_DEFINITIONS = [
  { key: "active", name: "Active", emoji: "🟢" },
  { key: "queued", name: "Queued", emoji: "📥" },
  { key: "in_progress", name: "In Progress", emoji: "🛠️" },
  { key: "pending_confirm", name: "Pending Confirm", emoji: "⏳" },
  { key: "completed", name: "Completed", emoji: "✅" },
  { key: "cancelled", name: "Cancelled", emoji: "❌" },
  { key: "paid", name: "Paid", emoji: "💸" },
  { key: "unpaid", name: "Unpaid", emoji: "💰" }
];

class TicketService {
  constructor(db) {
    this.db = db;
    this.client = null;
    this.dashboardMessageId = null;
    this.webhookCache = new Map();
  }

  initialize(client) {
    this.client = client;
  }

  shutdown() {
    this.client = null;
    this.webhookCache.clear();
  }

  getStaffRoleIds() {
    const configured = (config.discord?.tickets?.staffRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id)));
    if (configured.length) return configured;
    const fallback = config.discord?.commands?.commandRole;
    return /^\d{17,20}$/.test(String(fallback || "")) ? [String(fallback)] : [];
  }

  isStaff(member) {
    if (!member) return false;
    const staffRoleIds = this.getStaffRoleIds();
    if (staffRoleIds.length === 0) {
      const fallback = config.discord?.commands?.commandRole;
      return fallback ? member.roles?.cache?.has(fallback) : false;
    }

    return member.roles?.cache?.some((role) => staffRoleIds.includes(role.id));
  }

  getTicketLogsForumId() {
    return this.db.getBinding("ticket_logs_forum_id", config.discord?.tickets?.ticketLogsForumChannelId || null);
  }

  setTicketLogsForumId(channelId) {
    this.db.setBinding("ticket_logs_forum_id", channelId);
  }

  getTicketDashboardChannelId() {
    return this.db.getBinding("ticket_dashboard_channel_id", config.discord?.tickets?.dashboardChannelId || null);
  }

  setTicketDashboardChannelId(channelId) {
    this.db.setBinding("ticket_dashboard_channel_id", channelId);
  }

  buildDashboardEmbed() {
    return new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("Support Tickets")
      .setDescription("Create a support ticket using the buttons below.")
      .addFields(
        { name: "General Support", value: "Questions or generic issues." },
        { name: "Carry Issue", value: "Problems with an existing carry." },
        { name: "Payment Issue", value: "Payment-related disputes or confirmation issues." }
      );
  }

  buildDashboardRows() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${TICKET_CREATE_PREFIX}general`).setLabel("General Support").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${TICKET_CREATE_PREFIX}carry_issue`).setLabel("Carry Issue").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${TICKET_CREATE_PREFIX}payment_issue`).setLabel("Payment Issue").setStyle(ButtonStyle.Danger)
      )
    ];
  }

  buildTicketControlRows(ticketId) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${TICKET_ACTION_PREFIX}reopen:${ticketId}`).setLabel("Reopen Ticket").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${TICKET_ACTION_PREFIX}reassign_carrier:${ticketId}`).setLabel("Reassign Carrier(s)").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${TICKET_ACTION_PREFIX}reassign_customer:${ticketId}`).setLabel("Reassign Customer").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${TICKET_ACTION_PREFIX}delete_entry:${ticketId}`).setLabel("Delete Entry").setStyle(ButtonStyle.Danger)
      )
    ];
  }

  sanitizeNamePart(value, fallback) {
    const clean = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return clean || fallback;
  }

  async publishDashboard(channelId = null) {
    const targetId = channelId || this.getTicketDashboardChannelId();
    if (!targetId || !this.client) {
      return null;
    }

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      return null;
    }

    this.setTicketDashboardChannelId(channel.id);

    const existingId = this.db.getBinding("ticket_dashboard_message_id", null);
    let message = null;
    if (existingId) {
      message = await channel.messages.fetch(existingId).catch(() => null);
    }

    const payload = {
      embeds: [this.buildDashboardEmbed()],
      components: this.buildDashboardRows()
    };

    if (message && typeof message.edit === "function") {
      await message.edit(payload).catch(() => {});
      return message;
    }

    message = await channel.send(payload);
    this.db.setBinding("ticket_dashboard_message_id", message.id);
    return message;
  }

  getTicketById(ticketId) {
    return this.db.getConnection().prepare("SELECT * FROM tickets WHERE id = ?").get(Number(ticketId));
  }

  getTicketByForumThread(threadId) {
    return this.db.getConnection().prepare("SELECT * FROM tickets WHERE forum_thread_id = ?").get(String(threadId));
  }

  resolveLinkedIdentity(discordId) {
    try {
      const linked = JSON.parse(readFileSync("data/linked.json", "utf8"));
      const entry = Object.entries(linked || {}).find(([, value]) => String(value) === String(discordId));
      return entry ? { uuid: entry[0] } : null;
    } catch {
      return null;
    }
  }

  async createTicket({ guildId, type, title, customer, initialContent = "", source = "discord" }) {
    const now = Date.now();
    const customerId = customer?.id || null;
    const customerUsername = customer?.tag || customer?.username || "Unknown";

    const result = this.db
      .getConnection()
      .prepare(
        `INSERT INTO tickets (
          guild_id, type, title, status, customer_discord_id, customer_username, created_at, assigned_customer_discord_id
        ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`
      )
      .run(String(guildId || ""), String(type), title || `${type} Ticket`, customerId, customerUsername, now, customerId);

    const ticketId = Number(result.lastInsertRowid);
    this.db.logEvent("ticket.created", "ticket", ticketId, {
      type,
      source,
      customerId,
      customerUsername,
      initialContent
    });

    const thread = await this.ensureForumThreadForTicket(ticketId, {
      type,
      customer,
      title,
      initialContent
    });

    return {
      ticketId,
      thread
    };
  }

  async ensureForumThreadForTicket(ticketId, context = {}) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !this.client) {
      return null;
    }

    if (ticket.forum_thread_id) {
      const existing = await this.client.channels.fetch(ticket.forum_thread_id).catch(() => null);
      if (existing) return existing;
    }

    const forumId = this.getTicketLogsForumId();
    if (!forumId) {
      this.db.logEvent("ticket.thread_create_failed", "ticket", ticket.id, {
        forumId: null,
        error: "Ticket logs forum is not configured."
      });
      return null;
    }

    const forum = await this.client.channels.fetch(forumId).catch(() => null);
    if (!forum) {
      this.db.logEvent("ticket.thread_create_failed", "ticket", ticket.id, {
        forumId,
        error: "Forum channel could not be fetched (missing access or invalid channel id)."
      });
      return null;
    }

    if (forum.type !== ChannelType.GuildForum) {
      this.db.logEvent("ticket.thread_create_failed", "ticket", ticket.id, {
        forumId,
        error: `Configured channel is not a forum (type=${forum.type}).`
      });
      return null;
    }

    const typePart = this.sanitizeNamePart(context.type || ticket.type || "support", "support");
    const customerPart = this.sanitizeNamePart(ticket.customer_username || "customer", "customer");
    const name = `ticket-${typePart}-${customerPart}`.slice(0, 90);

    let starter = null;
    try {
      starter = await forum.threads.create({
        name,
        message: {
          content: `Ticket #${ticket.id} opened by <@${ticket.customer_discord_id || "0"}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle(context.title || ticket.title || "Support Ticket")
              .setDescription(context.initialContent || "No additional context provided.")
              .addFields(
                { name: "Ticket ID", value: String(ticket.id), inline: true },
                { name: "Type", value: String(ticket.type), inline: true },
                { name: "Customer", value: `<@${ticket.customer_discord_id || "0"}>`, inline: true }
              )
              .setTimestamp(new Date(ticket.created_at))
          ],
          components: this.buildTicketControlRows(ticket.id)
        }
      });
    } catch (error) {
      this.db.logEvent("ticket.thread_create_failed", "ticket", ticket.id, {
        forumId,
        error: error?.message || String(error)
      });
      return null;
    }

    const starterMessage = await starter.fetchStarterMessage().catch(() => null);

    this.db
      .getConnection()
      .prepare("UPDATE tickets SET forum_thread_id = ?, dashboard_message_id = ? WHERE id = ?")
      .run(starter.id, starterMessage?.id || null, ticket.id);

    await this.syncCarryThreadIndicators(ticket.id).catch(() => {});
    return starter;
  }

  getLatestCarryForTicket(ticketId) {
    if (!ticketId) return null;
    return this.db
      .getConnection()
      .prepare("SELECT * FROM carries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1")
      .get(Number(ticketId));
  }

  buildCarryIndicatorState(carry) {
    if (!carry) return { tagKeys: [], reactionEmojis: [] };

    const status = String(carry.status || "").toLowerCase();
    const tagKeys = [];
    const reactionEmojis = [];
    const statusToKey = {
      queued: "queued",
      claimed: "in_progress",
      in_progress: "in_progress",
      pending_confirm: "pending_confirm",
      completed: "completed",
      cancelled: "cancelled"
    };
    const stageKey = statusToKey[status] || "active";
    const isActive = ["queued", "claimed", "in_progress", "pending_confirm"].includes(status);
    const paymentKey = Number(carry.is_paid) === 1 ? "paid" : "unpaid";

    if (isActive) tagKeys.push("active");
    tagKeys.push(stageKey, paymentKey);

    const keyToEmoji = Object.fromEntries(CARRY_TAG_DEFINITIONS.map((item) => [item.key, item.emoji]));
    for (const key of tagKeys) {
      const emoji = keyToEmoji[key];
      if (emoji && !reactionEmojis.includes(emoji)) reactionEmojis.push(emoji);
    }

    return { tagKeys, reactionEmojis };
  }

  async ensureCarryForumTags(forumChannel) {
    if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) return {};

    const existing = Array.isArray(forumChannel.availableTags) ? forumChannel.availableTags : [];
    const byName = new Map(existing.map((tag) => [String(tag.name || "").toLowerCase(), tag]));
    const missing = CARRY_TAG_DEFINITIONS.filter((def) => !byName.has(def.name.toLowerCase()));

    if (missing.length > 0) {
      const nextTags = [
        ...existing.map((tag) => ({
          id: tag.id,
          name: tag.name,
          moderated: Boolean(tag.moderated),
          ...(tag.emojiId ? { emoji: { id: tag.emojiId } } : tag.emojiName ? { emoji: { name: tag.emojiName } } : {})
        })),
        ...missing.map((def) => ({
          name: def.name,
          moderated: false,
          emoji: { name: def.emoji }
        }))
      ];

      await forumChannel.setAvailableTags(nextTags).catch(() => {});
      await forumChannel.fetch(true).catch(() => {});
    }

    const refreshed = Array.isArray(forumChannel.availableTags) ? forumChannel.availableTags : [];
    const result = {};
    for (const def of CARRY_TAG_DEFINITIONS) {
      const found = refreshed.find((tag) => String(tag.name || "").toLowerCase() === def.name.toLowerCase());
      if (found?.id) result[def.key] = found.id;
    }
    return result;
  }

  async syncCarryThreadReactions(thread, ticket, reactionEmojis) {
    if (!thread || !ticket || !this.client) return;
    const managedEmojis = new Set(CARRY_TAG_DEFINITIONS.map((item) => item.emoji));
    const target = new Set(reactionEmojis || []);
    let starterMessage = null;

    if (ticket.dashboard_message_id) {
      starterMessage = await thread.messages.fetch(ticket.dashboard_message_id).catch(() => null);
    }

    if (!starterMessage) {
      starterMessage = await thread.fetchStarterMessage().catch(() => null);
    }

    if (!starterMessage) return;

    await starterMessage.fetch().catch(() => {});
    const reactions = [...starterMessage.reactions.cache.values()];
    for (const reaction of reactions) {
      const emoji = reaction.emoji?.name;
      if (!emoji || !managedEmojis.has(emoji) || target.has(emoji)) continue;
      await reaction.users.remove(this.client.user.id).catch(() => {});
    }

    for (const emoji of target) {
      await starterMessage.react(emoji).catch(() => {});
    }
  }

  async syncCarryThreadIndicators(ticketId, carryInput = null) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.forum_thread_id || !this.client) return;

    const carry = carryInput || this.getLatestCarryForTicket(ticket.id);
    if (!carry) return;

    const thread = await this.client.channels.fetch(ticket.forum_thread_id).catch(() => null);
    if (!thread) return;
    const forum = await this.client.channels.fetch(thread.parentId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) return;

    const { tagKeys, reactionEmojis } = this.buildCarryIndicatorState(carry);
    const managedTagIds = await this.ensureCarryForumTags(forum);
    const managedValues = new Set(Object.values(managedTagIds));
    const keepTags = Array.isArray(thread.appliedTags) ? thread.appliedTags.filter((tagId) => !managedValues.has(tagId)) : [];
    const applyManaged = tagKeys.map((key) => managedTagIds[key]).filter(Boolean);
    const nextApplied = [...new Set([...keepTags, ...applyManaged])];

    await thread.setAppliedTags(nextApplied).catch(() => {});
    await this.syncCarryThreadReactions(thread, ticket, reactionEmojis).catch(() => {});
  }

  async getForumWebhook(forumChannel) {
    if (!forumChannel) return null;
    if (this.webhookCache.has(forumChannel.id)) {
      return this.webhookCache.get(forumChannel.id);
    }

    const hooks = await forumChannel.fetchWebhooks().catch(() => null);
    if (!hooks) return null;

    let hook = hooks.find((item) => item.owner?.id === this.client?.user?.id) || hooks.first();
    if (!hook) {
      hook = await forumChannel.createWebhook({ name: "Carry Ticket Logs" }).catch(() => null);
    }

    if (hook) {
      this.webhookCache.set(forumChannel.id, hook);
    }

    return hook;
  }

  async mirrorMessage(ticketId, { content, username, avatarURL, authorDiscordId = null, viaWebhook = true }) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) return;

    this.db
      .getConnection()
      .prepare("INSERT INTO ticket_messages (ticket_id, author_discord_id, author_username, content, via_webhook, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ticket.id, authorDiscordId, username || "unknown", content || "", viaWebhook ? 1 : 0, Date.now());

    if (!ticket.forum_thread_id || !this.client || !content?.trim()) {
      return;
    }

    const thread = await this.client.channels.fetch(ticket.forum_thread_id).catch(() => null);
    if (!thread) return;

    const forum = await this.client.channels.fetch(thread.parentId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) return;

    const hook = await this.getForumWebhook(forum);
    if (!hook) return;

    await hook
      .send({
        threadId: thread.id,
        content: String(content).slice(0, 1900),
        username: String(username || "User").slice(0, 80),
        avatarURL: avatarURL || undefined,
        allowedMentions: { parse: [] }
      })
      .catch(() => {});
  }

  async onMessage(message) {
    if (!this.client || !message || message.author?.bot) {
      return;
    }

    let ticket = this.getTicketByForumThread(message.channelId);

    if (!ticket) {
      const carry = this.db.getConnection().prepare("SELECT id, ticket_id FROM carries WHERE execution_channel_id = ?").get(String(message.channelId));
      if (carry?.ticket_id) {
        ticket = this.getTicketById(carry.ticket_id);
      }
    }

    if (!ticket) {
      return;
    }

    // Avoid recursively mirroring forum thread entries.
    if (String(ticket.forum_thread_id) === String(message.channelId)) {
      this.db
        .getConnection()
        .prepare("INSERT INTO ticket_messages (ticket_id, author_discord_id, author_username, content, via_webhook, created_at) VALUES (?, ?, ?, ?, 0, ?)")
        .run(ticket.id, message.author.id, message.author.tag || message.author.username, message.content || "", Date.now());
      return;
    }

    await this.mirrorMessage(ticket.id, {
      content: message.content || (message.attachments.size ? "[attachment]" : ""),
      username: message.member?.displayName || message.author.username,
      avatarURL: message.author.displayAvatarURL?.() || null,
      authorDiscordId: message.author.id,
      viaWebhook: true
    });
  }

  static parseComponent(customId) {
    if (typeof customId !== "string") return null;
    if (customId.startsWith(TICKET_CREATE_PREFIX)) {
      return { kind: "create", type: customId.slice(TICKET_CREATE_PREFIX.length) };
    }

    if (customId.startsWith(TICKET_ACTION_PREFIX)) {
      const [, , action, ticketId] = customId.split(":");
      return { kind: "action", action, ticketId: Number(ticketId) };
    }

    return null;
  }

  async handleComponent(interaction) {
    const parsed = TicketService.parseComponent(interaction.customId);
    if (!parsed) return false;

    if (parsed.kind === "create") {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const result = await this.createTicket({
        guildId: interaction.guildId,
        type: parsed.type,
        title: `${parsed.type.replaceAll("_", " ")} ticket`,
        customer: interaction.user,
        initialContent: `Created from ticket dashboard by ${interaction.user.tag}`,
        source: "dashboard"
      });

      const threadMention = result.thread ? `<#${result.thread.id}>` : "ticket log thread";
      await interaction.editReply({ content: `Ticket #${result.ticketId} created. Staff has been notified in ${threadMention}.` });
      return true;
    }

    if (parsed.kind === "action") {
      if (!this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only staff can use this ticket action.", ephemeral: true });
        return true;
      }

      if (parsed.action === "reopen") {
        this.db.getConnection().prepare("UPDATE tickets SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1 WHERE id = ?").run(parsed.ticketId);
        this.db.logEvent("ticket.reopened", "ticket", parsed.ticketId, { actor: interaction.user.id });
        await this.syncCarryThreadIndicators(parsed.ticketId).catch(() => {});
        await interaction.reply({ content: `Ticket #${parsed.ticketId} reopened.`, ephemeral: true });
        return true;
      }

      if (parsed.action === "delete_entry") {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const result = await this.deleteTicketEntry(parsed.ticketId, interaction.user.id);
        await interaction.editReply({ content: result.ok ? `Ticket #${parsed.ticketId} fully deleted.` : `Delete failed: ${result.reason}` });
        return true;
      }

      if (["reassign_carrier", "reassign_customer"].includes(parsed.action)) {
        const modal = new ModalBuilder()
          .setCustomId(`${TICKET_MODAL_PREFIX}${parsed.action}:${parsed.ticketId}`)
          .setTitle(parsed.action === "reassign_customer" ? "Reassign Customer" : "Reassign Carrier(s)");

        const input = new TextInputBuilder()
          .setCustomId("value")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setLabel(parsed.action === "reassign_customer" ? "Customer Discord ID" : "Carrier Discord IDs (comma separated)");

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }
    }

    return false;
  }

  async handleModal(interaction) {
    if (!interaction.customId?.startsWith(TICKET_MODAL_PREFIX)) return false;
    if (!this.isStaff(interaction.member)) {
      await interaction.reply({ content: "Only staff can use this ticket action.", ephemeral: true });
      return true;
    }

    const payload = interaction.customId.slice(TICKET_MODAL_PREFIX.length);
    const [action, ticketIdRaw] = payload.split(":");
    const ticketId = Number(ticketIdRaw);
    const value = String(interaction.fields.getTextInputValue("value") || "").trim();

    if (!ticketId || !value) {
      await interaction.reply({ content: "Invalid ticket action payload.", ephemeral: true });
      return true;
    }

    if (action === "reassign_customer") {
      this.db.getConnection().prepare("UPDATE tickets SET assigned_customer_discord_id = ? WHERE id = ?").run(value, ticketId);
      this.db.logEvent("ticket.reassign_customer", "ticket", ticketId, { actor: interaction.user.id, value });
      await interaction.reply({ content: `Ticket #${ticketId} customer reassigned to <@${value}>.`, ephemeral: true });
      return true;
    }

    if (action === "reassign_carrier") {
      const ids = value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      this.db.getConnection().prepare("UPDATE tickets SET assigned_carrier_discord_ids = ? WHERE id = ?").run(JSON.stringify(ids), ticketId);
      this.db.logEvent("ticket.reassign_carrier", "ticket", ticketId, { actor: interaction.user.id, ids });
      await interaction.reply({ content: `Ticket #${ticketId} carriers updated.`, ephemeral: true });
      return true;
    }

    return false;
  }

  async closeTicket(ticketId) {
    this.db.getConnection().prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), Number(ticketId));
    this.db.logEvent("ticket.closed", "ticket", ticketId, {});
    await this.syncCarryThreadIndicators(Number(ticketId)).catch(() => {});
  }

  async deleteTicketEntry(ticketId, actorId = null) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) return { ok: false, reason: "Ticket not found." };

    const db = this.db.getConnection();
    const carries = db.prepare("SELECT id, execution_channel_id FROM carries WHERE ticket_id = ?").all(Number(ticketId));
    const channelsToDelete = carries
      .map((row) => String(row.execution_channel_id || ""))
      .filter(Boolean);

    const tx = db.transaction(() => {
      const carryIds = carries.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
      if (carryIds.length > 0) {
        const placeholders = carryIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM queue_entries WHERE carry_id IN (${placeholders})`).run(...carryIds);
        db.prepare(`DELETE FROM customer_ratings WHERE carry_id IN (${placeholders})`).run(...carryIds);
        db.prepare(`DELETE FROM carries WHERE id IN (${placeholders})`).run(...carryIds);
      }
      db.prepare("DELETE FROM ticket_messages WHERE ticket_id = ?").run(Number(ticketId));
      db.prepare("DELETE FROM tickets WHERE id = ?").run(Number(ticketId));
    });
    tx();

    for (const channelId of channelsToDelete) {
      const channel = await this.client?.channels?.fetch(channelId).catch(() => null);
      if (channel?.deletable) {
        await channel.delete(`Ticket #${ticketId} fully deleted by ${actorId || "staff"}`).catch(() => {});
      }
    }

    const thread = ticket.forum_thread_id ? await this.client?.channels?.fetch(ticket.forum_thread_id).catch(() => null) : null;
    if (thread?.deletable) {
      await thread.delete(`Ticket #${ticketId} fully deleted by ${actorId || "staff"}`).catch(() => {});
    }

    this.db.logEvent("ticket.deleted_entry", "ticket", ticketId, { actorId });
    return { ok: true };
  }

  async createCarryLinkedTicket({ guildId, customer, carryType, tier, amount }) {
    return this.createTicket({
      guildId,
      type: "manual_carry",
      title: `Carry Request - ${carryType} ${tier}`,
      customer,
      initialContent: `Carry request: ${carryType} ${tier} x${amount}`,
      source: "carry_request"
    });
  }

  async postTranscriptToTicket(ticketId, transcriptText) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.forum_thread_id || !this.client) return;

    const thread = await this.client.channels.fetch(ticket.forum_thread_id).catch(() => null);
    if (!thread) return;

    const preview = transcriptText.length > 1800 ? `${transcriptText.slice(0, 1800)}\n...` : transcriptText;
    await thread.send({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle(`Transcript for Ticket #${ticket.id}`).setDescription(`\`\`\`\n${preview}\n\`\`\``)]
    });
  }
}

module.exports = {
  TicketService,
  TICKET_CREATE_PREFIX,
  TICKET_ACTION_PREFIX,
  TICKET_MODAL_PREFIX
};
