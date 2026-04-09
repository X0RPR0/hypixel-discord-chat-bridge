const { ActionRowBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const { actionButton, makePanel, panelPayload } = require("./componentsV2Panels.js");
const { getUuidByDiscordId } = require("../../contracts/linkedStore.js");
const config = require("../../../config.json");

const TICKET_CREATE_PREFIX = "ticket:create:";
const TICKET_ACTION_PREFIX = "ticket:action:";
const TICKET_MODAL_PREFIX = "ticket:modal:";
const TICKET_PANEL_PREFIX = "ticket";
const TICKET_DASHBOARD_SCOPE = "ticket_dashboard";
const TICKET_VIEWS = ["open", "in_progress", "pending", "closed"];
const TICKET_EXPANDABLE = ["payment", "audit", "logs"];
const SERVICE_ADMIN_FALLBACK_NAMES = ["service-admin", "service admin", "serviceadmin"];
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
    this.formatCoinsShort = (value) => {
      const num = Number(value || 0);
      const abs = Math.abs(num);
      if (abs >= 1e9) return `${(num / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}b`;
      if (abs >= 1e6) return `${(num / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}m`;
      if (abs >= 1e3) return `${(num / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
      return `${Math.round(num)}`;
    };
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

  getAdminRoleIds(guild = null) {
    const fromCarryService = this.client?.carryService?.getAdminRoleIds?.(guild);
    if (Array.isArray(fromCarryService) && fromCarryService.length > 0) {
      return [...new Set(fromCarryService.map((id) => String(id)))];
    }

    const bound = this.db.getBinding("service_admin_role_id", null);
    const fromBinding = /^\d{17,20}$/.test(String(bound || "")) ? [String(bound)] : [];
    const fallback = this.getStaffRoleIds();
    const merged = new Set([...fromBinding, ...fallback]);
    if (merged.size > 0 || !guild?.roles?.cache) return [...merged];

    for (const role of guild.roles.cache.values()) {
      const normalized = String(role.name || "")
        .toLowerCase()
        .replace(/[\s_-]+/g, " ")
        .trim();
      if (SERVICE_ADMIN_FALLBACK_NAMES.includes(normalized)) merged.add(String(role.id));
    }
    return [...merged];
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

  getDashboardTicketRows(viewKey = "open") {
    const db = this.db.getConnection();
    const key = String(viewKey || "open").toLowerCase();
    if (key === "closed") {
      return db.prepare("SELECT id, type, status, customer_discord_id, created_at FROM tickets WHERE status = 'closed' ORDER BY id DESC LIMIT 50").all();
    }
    if (key === "pending") {
      return db
        .prepare(
          `SELECT t.id, t.type, t.status, t.customer_discord_id, t.created_at
           FROM tickets t
           WHERE EXISTS (SELECT 1 FROM carries c WHERE c.ticket_id = t.id AND c.status = 'pending_confirm')
           ORDER BY t.id DESC LIMIT 50`
        )
        .all();
    }
    if (key === "in_progress") {
      return db
        .prepare(
          `SELECT t.id, t.type, t.status, t.customer_discord_id, t.created_at
           FROM tickets t
           WHERE EXISTS (SELECT 1 FROM carries c WHERE c.ticket_id = t.id AND c.status IN ('claimed','in_progress'))
           ORDER BY t.id DESC LIMIT 50`
        )
        .all();
    }
    return db.prepare("SELECT id, type, status, customer_discord_id, created_at FROM tickets WHERE status = 'open' ORDER BY id DESC LIMIT 50").all();
  }

  getDashboardCounters() {
    const db = this.db.getConnection();
    const ticketRows = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
          COUNT(*) AS total_count
        FROM tickets`
      )
      .get();
    const carryRows = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status IN ('claimed', 'in_progress') THEN 1 ELSE 0 END) AS in_progress_count,
          SUM(CASE WHEN status = 'pending_confirm' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status = 'completed' AND completed_at >= ? THEN 1 ELSE 0 END) AS completed_today
        FROM carries`
      )
      .get(new Date(new Date().toDateString()).getTime());

    return {
      open: Number(ticketRows?.open_count || 0),
      inProgress: Number(carryRows?.in_progress_count || 0),
      pending: Number(carryRows?.pending_count || 0),
      closed: Number(ticketRows?.closed_count || 0),
      total: Number(ticketRows?.total_count || 0),
      completedToday: Number(carryRows?.completed_today || 0)
    };
  }

  getPanelState(messageId, actorId) {
    return (
      this.db.getUiPanelState({
        panelScope: TICKET_DASHBOARD_SCOPE,
        messageId: String(messageId || "0"),
        actorId: String(actorId || "0"),
        fallback: { viewKey: "open", page: 1, expanded: [] }
      }) || { viewKey: "open", page: 1, expanded: [] }
    );
  }

  setPanelState(messageId, actorId, next) {
    this.db.setUiPanelState({
      panelScope: TICKET_DASHBOARD_SCOPE,
      messageId: String(messageId || "0"),
      actorId: String(actorId || "0"),
      viewKey: next?.viewKey || "open",
      page: Math.max(1, Number(next?.page || 1)),
      expanded: Array.isArray(next?.expanded) ? next.expanded : []
    });
  }

  paginateRows(rows, page = 1, pageSize = 10) {
    const safePage = Math.max(1, Number(page || 1));
    const safePageSize = Math.max(1, Number(pageSize || 10));
    const total = Array.isArray(rows) ? rows.length : 0;
    const maxPage = Math.max(1, Math.ceil(total / safePageSize));
    const clampedPage = Math.min(safePage, maxPage);
    const start = (clampedPage - 1) * safePageSize;
    const items = rows.slice(start, start + safePageSize);
    return { items, page: clampedPage, maxPage, total };
  }

  buildDashboardPanel(options = {}) {
    const viewKey = TICKET_VIEWS.includes(String(options?.viewKey || "").toLowerCase()) ? String(options.viewKey).toLowerCase() : "open";
    const page = Math.max(1, Number(options?.page || 1));
    const expanded = Array.isArray(options?.expanded) ? options.expanded.filter((key) => TICKET_EXPANDABLE.includes(key)) : [];
    const rows = this.getDashboardTicketRows(viewKey);
    const counters = this.getDashboardCounters();
    const { items, page: currentPage, maxPage, total } = this.paginateRows(rows, page, 8);
    const list =
      items.length > 0
        ? items.map(
            (row) =>
              `- #${row.id} **${row.type}** | <@${row.customer_discord_id || "0"}> | ${row.status} | <t:${Math.floor(Number(row.created_at || Date.now()) / 1000)}:R>`
          )
        : ["No tickets in this view."];

    const sections = [
      {
        title: "Summary",
        lines: [
          `- Queue Size: **${counters.open}**`,
          `- In Progress: **${counters.inProgress}**`,
          `- Pending: **${counters.pending}**`,
          `- Closed: **${counters.closed}**`,
          `- Completed Today: **${counters.completedToday}**`
        ]
      },
      {
        title: "Categories",
        lines: ["- General Support: questions or generic issues.", "- Carry Issue: problems with an existing carry.", "- Payment Issue: disputes or confirmation issues."]
      },
      {
        title: "Ticket List",
        lines: [`Page **${currentPage}/${maxPage}** | Showing **${items.length}/${total}** in **${viewKey}**`, ...list]
      }
    ];

    if (expanded.includes("payment")) {
      const payment = this.db
        .getConnection()
        .prepare(
          `SELECT
            COALESCE(SUM(final_price), 0) AS total_price,
            COALESCE(SUM(paid_amount), 0) AS paid_amount,
            COALESCE(SUM(final_price - paid_amount), 0) AS remaining_amount
          FROM carries
          WHERE status IN ('queued', 'claimed', 'in_progress', 'pending_confirm')`
        )
        .get();
      sections.push({
        title: "Payment Breakdown",
        lines: [
          `- Active Total: **${this.formatCoinsShort(payment?.total_price || 0)}**`,
          `- Paid: **${this.formatCoinsShort(payment?.paid_amount || 0)}**`,
          `- Remaining: **${this.formatCoinsShort(payment?.remaining_amount || 0)}**`
        ]
      });
    }

    if (expanded.includes("audit")) {
      const recent = this.db.getConnection().prepare("SELECT event_type, entity_id, created_at FROM events WHERE entity_type = 'ticket' ORDER BY id DESC LIMIT 5").all();
      sections.push({
        title: "Audit Details",
        lines:
          recent.length > 0
            ? recent.map((entry) => `- ${String(entry.event_type)} on #${entry.entity_id} at <t:${Math.floor(Number(entry.created_at || Date.now()) / 1000)}:R>`)
            : ["No recent ticket audit events."]
      });
    }

    if (expanded.includes("logs")) {
      const recent = this.db.getConnection().prepare("SELECT ticket_id, author_username, created_at FROM ticket_messages ORDER BY id DESC LIMIT 5").all();
      sections.push({
        title: "Logs Summary",
        lines:
          recent.length > 0
            ? recent.map(
                (entry) => `- #${entry.ticket_id} by **${entry.author_username || "unknown"}** at <t:${Math.floor(Number(entry.created_at || Date.now()) / 1000)}:R>`
              )
            : ["No mirrored logs yet."]
      });
    }

    return makePanel({
      title: "Support Tickets",
      status: `${viewKey} (${total})`,
      sections,
      actions: [
        actionButton(`${TICKET_CREATE_PREFIX}general`, "General Support", 1),
        actionButton(`${TICKET_CREATE_PREFIX}carry_issue`, "Carry Issue", 2),
        actionButton(`${TICKET_CREATE_PREFIX}payment_issue`, "Payment Issue", 4)
      ],
      tabs: [
        actionButton(`${TICKET_PANEL_PREFIX}:view:dashboard:open`, "Open", 2, { disabled: viewKey === "open" }),
        actionButton(`${TICKET_PANEL_PREFIX}:view:dashboard:in_progress`, "In Progress", 2, { disabled: viewKey === "in_progress" }),
        actionButton(`${TICKET_PANEL_PREFIX}:view:dashboard:pending`, "Pending", 2, { disabled: viewKey === "pending" }),
        actionButton(`${TICKET_PANEL_PREFIX}:view:dashboard:closed`, "Closed", 2, { disabled: viewKey === "closed" })
      ],
      nav: [
        actionButton(`${TICKET_PANEL_PREFIX}:page:dashboard:${Math.max(1, currentPage - 1)}`, "Prev", 2, { disabled: currentPage <= 1 }),
        actionButton(`${TICKET_PANEL_PREFIX}:page:dashboard:${Math.min(maxPage, currentPage + 1)}`, "Next", 2, { disabled: currentPage >= maxPage }),
        actionButton(`${TICKET_PANEL_PREFIX}:jump:dashboard`, "Jump", 1),
        actionButton(`${TICKET_PANEL_PREFIX}:refresh:dashboard`, "Refresh", 2),
        actionButton(
          `${TICKET_PANEL_PREFIX}:toggle:dashboard:${expanded.includes("payment") ? "hide_payment" : "show_payment"}`,
          expanded.includes("payment") ? "Hide Payment" : "Show Payment",
          2
        ),
        actionButton(
          `${TICKET_PANEL_PREFIX}:toggle:dashboard:${expanded.includes("audit") ? "hide_audit" : "show_audit"}`,
          expanded.includes("audit") ? "Hide Audit" : "Show Audit",
          2
        ),
        actionButton(
          `${TICKET_PANEL_PREFIX}:toggle:dashboard:${expanded.includes("logs") ? "hide_logs" : "show_logs"}`,
          expanded.includes("logs") ? "Hide Logs" : "Show Logs",
          2
        )
      ],
      accentColor: 0x3498db,
      footer: `Expanded: ${expanded.length ? expanded.join(", ") : "none"}`
    });
  }

  buildDashboardRows() {
    return [];
  }

  buildTicketControlRows(ticketId) {
    return [
      actionButton(`${TICKET_ACTION_PREFIX}reopen:${ticketId}`, "Reopen Ticket", 1),
      actionButton(`${TICKET_ACTION_PREFIX}reassign_carrier:${ticketId}`, "Reassign Carrier(s)", 2),
      actionButton(`${TICKET_ACTION_PREFIX}reassign_customer:${ticketId}`, "Reassign Customer", 2),
      actionButton(`${TICKET_ACTION_PREFIX}delete_entry:${ticketId}`, "Delete Entry", 4)
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

  buildTicketDisplayName({ type, amount, name }) {
    const typePart = this.sanitizeNamePart(type || "carry", "carry");
    const amountPart = this.sanitizeNamePart(amount || "-", "-");
    const namePart = this.sanitizeNamePart(name || "customer", "customer");
    return `├🎟️》${typePart}-${amountPart}-${namePart}`.slice(0, 100);
  }

  async publishDashboard(channelId = null, options = {}) {
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

    const payload = panelPayload(
      this.buildDashboardPanel({
        viewKey: String(options?.viewKey || "open"),
        page: Number(options?.page || 1),
        expanded: Array.isArray(options?.expanded) ? options.expanded : []
      })
    );

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
    const uuid = getUuidByDiscordId(discordId);
    return uuid ? { uuid } : null;
  }

  async createTicket({ guildId, type, title, customer, initialContent = "", source = "discord", amount = null }) {
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
      amount,
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

    const name = this.buildTicketDisplayName({
      type: context.type || ticket.type || "support",
      amount: context.amount || "-",
      name: context.customer?.username || context.customer?.tag || ticket.customer_username || "customer"
    });

    let starter = null;
    try {
      starter = await forum.threads.create({
        name,
        message: {
          ...panelPayload(
            makePanel({
              title: context.title || ticket.title || "Support Ticket",
              status: String(ticket.status || "open"),
              sections: [
                {
                  title: "Ticket",
                  lines: [
                    `- Ticket ID: **${ticket.id}**`,
                    `- Type: **${String(ticket.type)}**`,
                    `- Customer: <@${ticket.customer_discord_id || "0"}>`,
                    `- Opened By: <@${ticket.customer_discord_id || "0"}>`
                  ]
                },
                {
                  title: "Initial Context",
                  lines: [context.initialContent || "No additional context provided."]
                }
              ],
              actions: this.buildTicketControlRows(ticket.id),
              accentColor: 0x2ecc71,
              footer: `Created: <t:${Math.floor(Number(ticket.created_at || Date.now()) / 1000)}:f>`
            })
          )
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

    const adminRoleIds = this.getAdminRoleIds(starter.guild || forum.guild);
    for (const roleId of adminRoleIds) {
      await starter.permissionOverwrites?.edit(roleId, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }).catch(() => {});
    }

    this.db
      .getConnection()
      .prepare("UPDATE tickets SET forum_thread_id = ?, dashboard_message_id = ? WHERE id = ?")
      .run(starter.id, starterMessage?.id || null, ticket.id);

    await this.syncCarryThreadIndicators(ticket.id).catch(() => {});
    return starter;
  }

  getLatestCarryForTicket(ticketId) {
    if (!ticketId) return null;
    return this.db.getConnection().prepare("SELECT * FROM carries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(Number(ticketId));
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
    let carryIdForActivity = null;

    if (!ticket) {
      const carry = this.db.getConnection().prepare("SELECT id, ticket_id FROM carries WHERE execution_channel_id = ?").get(String(message.channelId));
      if (carry?.ticket_id) {
        ticket = this.getTicketById(carry.ticket_id);
        carryIdForActivity = Number(carry.id);
      }
    } else {
      const carry = this.db.getConnection().prepare("SELECT id FROM carries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(Number(ticket.id));
      if (carry?.id) carryIdForActivity = Number(carry.id);
    }

    if (!ticket) {
      return;
    }

    if (carryIdForActivity) {
      this.client?.carryService?.touchCarryActivity?.(carryIdForActivity, Number(message.createdTimestamp || Date.now()));
      // Keep the execution control panel sticky at the bottom after chat activity.
      this.client?.carryService?.refreshExecutionPanel?.(carryIdForActivity).catch(() => {});
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
    if (interaction.customId?.startsWith(`${TICKET_PANEL_PREFIX}:view:dashboard:`)) {
      const viewKey = String(interaction.customId.split(":").pop() || "open").toLowerCase();
      const messageId = interaction.message?.id || this.db.getBinding("ticket_dashboard_message_id", "0");
      const actorId = interaction.user?.id || "0";
      const nextView = TICKET_VIEWS.includes(viewKey) ? viewKey : "open";
      const current = this.getPanelState(messageId, actorId);
      this.setPanelState(messageId, actorId, { viewKey: nextView, page: 1, expanded: current.expanded });
      await interaction.update(panelPayload(this.buildDashboardPanel({ viewKey: nextView, page: 1, expanded: current.expanded }))).catch(async () => {
        await this.publishDashboard(null, { viewKey: nextView, page: 1, expanded: current.expanded }).catch(() => {});
      });
      return true;
    }

    if (interaction.customId?.startsWith(`${TICKET_PANEL_PREFIX}:page:dashboard:`)) {
      const page = Math.max(1, Number(interaction.customId.split(":").pop() || 1));
      const messageId = interaction.message?.id || this.db.getBinding("ticket_dashboard_message_id", "0");
      const actorId = interaction.user?.id || "0";
      const current = this.getPanelState(messageId, actorId);
      this.setPanelState(messageId, actorId, { viewKey: current.viewKey, page, expanded: current.expanded });
      await interaction.update(panelPayload(this.buildDashboardPanel({ viewKey: current.viewKey, page, expanded: current.expanded }))).catch(async () => {
        await this.publishDashboard(null, { viewKey: current.viewKey, page, expanded: current.expanded }).catch(() => {});
      });
      return true;
    }

    if (interaction.customId === `${TICKET_PANEL_PREFIX}:jump:dashboard`) {
      const modal = new ModalBuilder().setCustomId(`${TICKET_MODAL_PREFIX}jump:dashboard:${interaction.message?.id || "0"}`).setTitle("Jump To Page");
      const input = new TextInputBuilder().setCustomId("page").setStyle(TextInputStyle.Short).setRequired(true).setLabel("Page Number");
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    if (interaction.customId === `${TICKET_PANEL_PREFIX}:refresh:dashboard`) {
      const messageId = interaction.message?.id || this.db.getBinding("ticket_dashboard_message_id", "0");
      const actorId = interaction.user?.id || "0";
      const current = this.getPanelState(messageId, actorId);
      await interaction.update(panelPayload(this.buildDashboardPanel({ viewKey: current.viewKey, page: current.page, expanded: current.expanded }))).catch(async () => {
        await this.publishDashboard(null, { viewKey: current.viewKey, page: current.page, expanded: current.expanded }).catch(() => {});
      });
      return true;
    }

    if (interaction.customId?.startsWith(`${TICKET_PANEL_PREFIX}:toggle:dashboard:`)) {
      const mode = String(interaction.customId.split(":").pop() || "show_payment");
      const messageId = interaction.message?.id || this.db.getBinding("ticket_dashboard_message_id", "0");
      const actorId = interaction.user?.id || "0";
      const current = this.getPanelState(messageId, actorId);
      const expanded = new Set(Array.isArray(current.expanded) ? current.expanded : []);
      if (mode === "show_payment") expanded.add("payment");
      if (mode === "hide_payment") expanded.delete("payment");
      if (mode === "show_audit") expanded.add("audit");
      if (mode === "hide_audit") expanded.delete("audit");
      if (mode === "show_logs") expanded.add("logs");
      if (mode === "hide_logs") expanded.delete("logs");
      const next = { viewKey: current.viewKey, page: current.page, expanded: [...expanded] };
      this.setPanelState(messageId, actorId, next);
      await interaction.update(panelPayload(this.buildDashboardPanel(next))).catch(async () => {
        await this.publishDashboard(null, next).catch(() => {});
      });
      return true;
    }
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
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        this.db.getConnection().prepare("UPDATE tickets SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1 WHERE id = ?").run(parsed.ticketId);
        this.db.logEvent("ticket.reopened", "ticket", parsed.ticketId, { actor: interaction.user.id });
        const carryResult = await this.client?.carryService?.reopenCarryForTicket?.(parsed.ticketId, interaction.user.id).catch((error) => ({
          ok: false,
          reason: error?.message || String(error)
        }));
        await this.syncCarryThreadIndicators(parsed.ticketId).catch(() => {});
        const suffix = carryResult?.ok ? ` ${carryResult?.message || ""}`.trim() : ` Carry reopen failed: ${carryResult?.reason || "unknown error"}`;
        await interaction.editReply({ content: `Ticket #${parsed.ticketId} reopened.${suffix ? ` ${suffix}` : ""}`.trim() });
        return true;
      }

      if (parsed.action === "delete_entry") {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const result = await this.deleteTicketEntry(parsed.ticketId, interaction.user.id);
        const details = Array.isArray(result.details) && result.details.length ? `\nDetails: ${result.details.join(" | ")}` : "";
        await interaction.editReply({ content: result.ok ? `Ticket #${parsed.ticketId} fully deleted.${details}` : `Delete failed: ${result.reason}${details}` });
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

    const payload = interaction.customId.slice(TICKET_MODAL_PREFIX.length);
    if (payload.startsWith("jump:dashboard:")) {
      const messageId = String(payload.split(":")[2] || this.db.getBinding("ticket_dashboard_message_id", "0"));
      const actorId = interaction.user?.id || "0";
      const page = Math.max(1, Number(interaction.fields.getTextInputValue("page") || 1));
      const current = this.getPanelState(messageId, actorId);
      this.setPanelState(messageId, actorId, { viewKey: current.viewKey, page, expanded: current.expanded });
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      await this.publishDashboard(null, { viewKey: current.viewKey, page, expanded: current.expanded }).catch(() => {});
      await interaction.editReply({ content: `Moved to page ${page}.` });
      return true;
    }

    if (!this.isStaff(interaction.member)) {
      await interaction.reply({ content: "Only staff can use this ticket action.", ephemeral: true });
      return true;
    }

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
    const details = [];
    const carries = db.prepare("SELECT id, execution_channel_id FROM carries WHERE ticket_id = ?").all(Number(ticketId));
    const channelsToDelete = carries.map((row) => String(row.execution_channel_id || "")).filter(Boolean);
    const thread = ticket.forum_thread_id ? await this.client?.channels?.fetch(ticket.forum_thread_id).catch(() => null) : null;

    try {
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
    } catch (error) {
      details.push(`db: ${error?.message || String(error)}`);
      return { ok: false, reason: "Database cleanup failed.", details };
    }

    for (const channelId of channelsToDelete) {
      const channel = await this.client?.channels?.fetch(channelId).catch(() => null);
      if (channel) {
        const deleted = await channel.delete(`Ticket #${ticketId} fully deleted by ${actorId || "staff"}`).catch((error) => ({ __error: error }));
        if (deleted?.__error) {
          details.push(`execution-channel:${channelId} ${deleted.__error?.message || "delete failed"}`);
        }
      }
    }

    if (thread) {
      // Try to unlock/unarchive first in case forum moderation state blocks delete.
      if (typeof thread.setArchived === "function") {
        await thread.setArchived(false).catch(() => {});
      }
      if (typeof thread.setLocked === "function") {
        await thread.setLocked(false).catch(() => {});
      }

      const deletedThread = await thread.delete(`Ticket #${ticketId} fully deleted by ${actorId || "staff"}`).catch((error) => ({ __error: error }));
      if (deletedThread?.__error) {
        details.push(`forum-thread:${thread.id} ${deletedThread.__error?.message || "delete failed"}`);
      }
    }

    this.db.logEvent("ticket.deleted_entry", "ticket", ticketId, { actorId, details });
    if (details.length > 0) {
      return {
        ok: false,
        reason: "Database entry deleted, but one or more Discord objects could not be deleted.",
        details
      };
    }
    return { ok: true, details: [] };
  }

  async deleteOldTicketEntries({ beforeTicketId = null, olderThanDays = null, limit = 100, actorId = null, dryRun = false } = {}) {
    const predicates = [];
    const params = [];

    if (Number.isInteger(Number(beforeTicketId)) && Number(beforeTicketId) > 0) {
      predicates.push("id < ?");
      params.push(Number(beforeTicketId));
    }

    if (Number.isInteger(Number(olderThanDays)) && Number(olderThanDays) > 0) {
      const cutoff = Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000;
      predicates.push("created_at <= ?");
      params.push(cutoff);
    }

    if (predicates.length === 0) {
      return { ok: false, reason: "Provide beforeTicketId and/or olderThanDays." };
    }

    const cleanLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const where = predicates.join(" AND ");
    const rows = this.db
      .getConnection()
      .prepare(`SELECT id FROM tickets WHERE ${where} ORDER BY id ASC LIMIT ?`)
      .all(...params, cleanLimit);
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));

    if (dryRun) {
      return { ok: true, dryRun: true, matched: ids.length, ids };
    }

    let deleted = 0;
    let failed = 0;
    const errorDetails = [];
    for (const id of ids) {
      const result = await this.deleteTicketEntry(id, actorId);
      if (result.ok) {
        deleted += 1;
      } else {
        failed += 1;
        if (errorDetails.length < 20) errorDetails.push(`ticket#${id}: ${result.reason}`);
      }
    }

    return { ok: true, matched: ids.length, deleted, failed, errorDetails };
  }

  async createCarryLinkedTicket({ guildId, customer, carryType, tier, amount }) {
    return this.createTicket({
      guildId,
      type: `${carryType}-${tier}`,
      title: `Carry Request - ${carryType} ${tier}`,
      customer,
      initialContent: `Carry request: ${carryType} ${tier} x${amount}`,
      source: "carry_request",
      amount
    });
  }

  async postTranscriptToTicket(ticketId, transcriptText) {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.forum_thread_id || !this.client) return;

    const thread = await this.client.channels.fetch(ticket.forum_thread_id).catch(() => null);
    if (!thread) return;

    const preview = transcriptText.length > 1800 ? `${transcriptText.slice(0, 1800)}\n...` : transcriptText;
    await thread.send(
      panelPayload(
        makePanel({
          title: `Transcript for Ticket #${ticket.id}`,
          status: "Archived Snapshot",
          sections: [{ title: "Transcript", lines: [`\`\`\`\n${preview}\n\`\`\``] }],
          accentColor: 0x95a5a6
        })
      )
    );
  }
}

module.exports = {
  TicketService,
  TICKET_CREATE_PREFIX,
  TICKET_ACTION_PREFIX,
  TICKET_MODAL_PREFIX
};
