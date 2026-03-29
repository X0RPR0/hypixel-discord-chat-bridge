
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { readFileSync } = require("fs");
const DiscountEngine = require("./discountEngine.js");
const EtaEngine = require("./etaEngine.js");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const config = require("../../../config.json");

const CARRY_PREFIX = "carry:";
const CARRY_MODAL_PREFIX = "carrymodal:";

class CarryService {
  constructor(db, ticketService) {
    this.db = db;
    this.ticketService = ticketService;
    this.client = null;
    this.discountEngine = new DiscountEngine(db);
    this.etaEngine = new EtaEngine(db);
    this.reassignmentInterval = null;
  }

  initialize(client) {
    this.client = client;
    this.seedDefaultCatalog();
    this.startWatchdog();
  }

  shutdown() {
    if (this.reassignmentInterval) {
      clearInterval(this.reassignmentInterval);
      this.reassignmentInterval = null;
    }

    this.client = null;
  }

  startWatchdog() {
    if (this.reassignmentInterval) clearInterval(this.reassignmentInterval);
    this.reassignmentInterval = setInterval(() => {
      this.checkStaleQueueEntries().catch(() => {});
    }, 60000);
  }

  seedDefaultCatalog() {
    const db = this.db.getConnection();
    const defaults = [
      ["dungeons", "f1", "dungeons"],
      ["dungeons", "f2", "dungeons"],
      ["dungeons", "f3", "dungeons"],
      ["dungeons", "f4", "dungeons"],
      ["dungeons", "f5", "dungeons"],
      ["dungeons", "f6", "dungeons"],
      ["dungeons", "f7", "dungeons"],
      ["dungeons", "m1", "dungeons"],
      ["dungeons", "m2", "dungeons"],
      ["dungeons", "m3", "dungeons"],
      ["dungeons", "m4", "dungeons"],
      ["dungeons", "m5", "dungeons"],
      ["dungeons", "m6", "dungeons"],
      ["dungeons", "m7", "dungeons"],
      ["slayer_zombie", "1", "slayers"],
      ["slayer_zombie", "2", "slayers"],
      ["slayer_zombie", "3", "slayers"],
      ["slayer_zombie", "4", "slayers"],
      ["slayer_zombie", "5", "slayers"],
      ["slayer_tara", "1", "slayers"],
      ["slayer_tara", "2", "slayers"],
      ["slayer_tara", "3", "slayers"],
      ["slayer_tara", "4", "slayers"],
      ["slayer_tara", "5", "slayers"],
      ["slayer_sven", "1", "slayers"],
      ["slayer_sven", "2", "slayers"],
      ["slayer_sven", "3", "slayers"],
      ["slayer_sven", "4", "slayers"],
      ["slayer_eman", "1", "slayers"],
      ["slayer_eman", "2", "slayers"],
      ["slayer_eman", "3", "slayers"],
      ["slayer_eman", "4", "slayers"],
      ["slayer_blaze", "1", "slayers"],
      ["slayer_blaze", "2", "slayers"],
      ["slayer_blaze", "3", "slayers"],
      ["slayer_blaze", "4", "slayers"],
      ["slayer_blaze", "5", "slayers"],
      ["kuudra", "basic", "kuudra"],
      ["kuudra", "hot", "kuudra"],
      ["kuudra", "burning", "kuudra"],
      ["kuudra", "fiery", "kuudra"],
      ["kuudra", "infernal", "kuudra"]
    ];

    const insert = db.prepare(
      "INSERT INTO carry_catalog (carry_type, tier, category, price, enabled) VALUES (?, ?, ?, 0, 1) ON CONFLICT(carry_type, tier) DO NOTHING"
    );

    const tx = db.transaction(() => {
      for (const row of defaults) {
        insert.run(row[0], row[1], row[2]);
      }
    });
    tx();
  }

  getCarrierRoleIds() {
    return config.discord?.carry?.carrierRoleIds || [];
  }

  getStaffRoleIds() {
    return config.discord?.tickets?.staffRoleIds || [];
  }

  isStaff(member) {
    const configured = this.getStaffRoleIds();
    const fallback = config.discord?.commands?.commandRole;
    const roles = member?.roles?.cache;
    if (!roles) return false;
    if (configured.length > 0) {
      return roles.some((role) => configured.includes(role.id));
    }
    return fallback ? roles.has(fallback) : false;
  }

  isCarrier(member) {
    const carrierRoles = this.getCarrierRoleIds();
    if (!member?.roles?.cache) return false;
    if (carrierRoles.length === 0) {
      return this.isStaff(member);
    }

    return member.roles.cache.some((role) => carrierRoles.includes(role.id)) || this.isStaff(member);
  }

  setCarryDashboardChannelId(channelId) {
    this.db.setBinding("carry_dashboard_channel_id", channelId);
  }

  getCarryDashboardChannelId() {
    return this.db.getBinding("carry_dashboard_channel_id", config.discord?.carry?.dashboardChannelId || null);
  }

  setCarrierDashboardChannelId(channelId) {
    this.db.setBinding("carrier_dashboard_channel_id", channelId);
  }

  getCarrierDashboardChannelId() {
    return this.db.getBinding("carrier_dashboard_channel_id", config.discord?.carry?.carrierDashboardChannelId || null);
  }

  setCarryCategoryId(categoryId) {
    this.db.setBinding("carry_category_id", categoryId);
  }

  getCarryCategoryId() {
    return this.db.getBinding("carry_category_id", config.discord?.carry?.categoryId || null);
  }

  setCarryAutoDelete(msValue) {
    this.db.setBinding("carry_autodelete_ms", Number(msValue));
  }

  getCarryAutoDeleteMs() {
    return Number(this.db.getBinding("carry_autodelete_ms", 30 * 60 * 1000));
  }

  setCarryTranscriptEnabled(enabled) {
    this.db.setBinding("carry_transcript_enabled", Boolean(enabled));
  }

  isCarryTranscriptEnabled() {
    return Boolean(this.db.getBinding("carry_transcript_enabled", true));
  }

  setQueueEnabled(enabled) {
    this.db.setBinding("queue_enabled", Boolean(enabled));
  }

  isQueueEnabled() {
    return Boolean(this.db.getBinding("queue_enabled", true));
  }

  setFreeCarryLimit(limit) {
    this.db.setBinding("free_carry_limit", Number(limit));
  }

  getFreeCarryLimit() {
    return Number(this.db.getBinding("free_carry_limit", 1));
  }
  getWeekKeyUtc(ts = Date.now()) {
    const date = new Date(ts);
    const year = date.getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, 1));
    const diffDays = Math.floor((date - start) / 86400000);
    const week = Math.floor(diffDays / 7) + 1;
    return `${year}-W${String(week).padStart(2, "0")}`;
  }

  canUseFreeCarry(userId) {
    const weekKey = this.getWeekKeyUtc();
    const limit = this.getFreeCarryLimit();
    const row = this.db.getConnection().prepare("SELECT used_count FROM freecarry_usage WHERE user_id = ? AND week_key = ?").get(String(userId), weekKey);
    const used = Number(row?.used_count || 0);
    return used < limit;
  }

  consumeFreeCarry(userId) {
    const weekKey = this.getWeekKeyUtc();
    this.db
      .getConnection()
      .prepare(
        `INSERT INTO freecarry_usage (user_id, week_key, used_count)
         VALUES (?, ?, 1)
         ON CONFLICT(user_id, week_key)
         DO UPDATE SET used_count = used_count + 1`
      )
      .run(String(userId), weekKey);
  }

  resetFreeCarryWeekly() {
    this.db.logEvent("freecarry.weekly_reset", "system", "global", { at: Date.now() });
  }

  resetQueue() {
    const db = this.db.getConnection();
    db.prepare("DELETE FROM queue_entries").run();
    db.prepare("UPDATE carries SET status = 'cancelled', cancelled_at = ? WHERE status IN ('queued', 'claimed')").run(Date.now());
    this.db.logEvent("queue.reset", "queue", "global", {});
  }

  setRolePriority(roleId, value) {
    this.db.getConnection().prepare("INSERT INTO role_priorities (role_id, value) VALUES (?, ?) ON CONFLICT(role_id) DO UPDATE SET value = excluded.value").run(roleId, Number(value));
  }

  getRolePriorityScore(member) {
    if (!member?.roles?.cache) return 0;
    const roleIds = member.roles.cache.map((role) => role.id);
    if (roleIds.length === 0) return 0;
    const placeholders = roleIds.map(() => "?").join(",");
    const rows = this.db.getConnection().prepare(`SELECT value FROM role_priorities WHERE role_id IN (${placeholders})`).all(...roleIds);
    if (!rows.length) return 0;
    return Math.max(...rows.map((row) => Number(row.value || 0)));
  }

  getCatalogItem(type, tier) {
    return this.db
      .getConnection()
      .prepare("SELECT * FROM carry_catalog WHERE lower(carry_type) = lower(?) AND lower(tier) = lower(?)")
      .get(String(type), String(tier));
  }

  addCarryTypeWithTiers(name, tiersText) {
    const tiers = String(tiersText)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const db = this.db.getConnection();
    const stmt = db.prepare(
      "INSERT INTO carry_catalog (carry_type, tier, category, price, enabled) VALUES (?, ?, ?, 0, 1) ON CONFLICT(carry_type, tier) DO NOTHING"
    );
    const tx = db.transaction(() => {
      for (const tier of tiers) {
        stmt.run(name.toLowerCase(), tier.toLowerCase(), this.inferCategory(name));
      }
    });
    tx();
    return tiers.length;
  }

  inferCategory(type) {
    const lower = String(type).toLowerCase();
    if (lower.includes("kuudra")) return "kuudra";
    if (lower.includes("slayer") || lower.includes("zombie") || lower.includes("tara") || lower.includes("sven") || lower.includes("eman") || lower.includes("blaze")) {
      return "slayers";
    }
    return "dungeons";
  }

  removeCarryType(type) {
    return this.db.getConnection().prepare("DELETE FROM carry_catalog WHERE lower(carry_type) = lower(?)").run(type).changes;
  }

  setCarryPrice(type, tier, price) {
    return this.db
      .getConnection()
      .prepare("UPDATE carry_catalog SET price = ? WHERE lower(carry_type) = lower(?) AND lower(tier) = lower(?)")
      .run(Number(price), type, tier).changes;
  }

  setCarryEnabled(type, enabled) {
    return this.db.getConnection().prepare("UPDATE carry_catalog SET enabled = ? WHERE lower(carry_type) = lower(?)").run(enabled ? 1 : 0, type).changes;
  }

  getQueueRows() {
    return this.db
      .getConnection()
      .prepare(
        `SELECT q.*, c.carry_type, c.tier, c.amount, c.customer_discord_id, c.final_price, c.is_paid, c.is_free, c.status
         FROM queue_entries q
         JOIN carries c ON c.id = q.carry_id
         WHERE q.state IN ('queued', 'claimed')
         ORDER BY q.priority_score DESC, q.created_at ASC`
      )
      .all();
  }

  getEnabledCatalog() {
    return this.db
      .getConnection()
      .prepare("SELECT carry_type, tier, category, price FROM carry_catalog WHERE enabled = 1 ORDER BY category ASC, carry_type ASC, tier ASC")
      .all();
  }

  getActiveCarrierStats() {
    const row = this.db
      .getConnection()
      .prepare("SELECT COUNT(*) AS active FROM carrier_stats WHERE updated_at >= ?")
      .get(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return Number(row?.active || 0);
  }

  async publishCarryDashboard(channelId = null) {
    const targetId = channelId || this.getCarryDashboardChannelId();
    if (!targetId || !this.client) return null;

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;

    this.setCarryDashboardChannelId(channel.id);

    const messageId = this.db.getBinding("carry_dashboard_message_id", null);
    let message = null;
    if (messageId) message = await channel.messages.fetch(messageId).catch(() => null);

    const catalog = this.getEnabledCatalog();
    const byCategory = new Map();
    for (const item of catalog) {
      const key = String(item.category || "other");
      const list = byCategory.get(key) || [];
      list.push(item);
      byCategory.set(key, list);
    }

    const rows = [];
    for (const [category, items] of byCategory.entries()) {
      const options = items.slice(0, 25).map((item) => ({
        label: `${item.carry_type} ${item.tier}`.slice(0, 100),
        description: `Price: ${Number(item.price || 0)} each`.slice(0, 100),
        value: `${item.carry_type}|${item.tier}`.slice(0, 100)
      }));
      if (options.length === 0) continue;

      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`${CARRY_PREFIX}select:${category}`)
            .setPlaceholder(`Select ${category} carry`)
            .addOptions(options)
        )
      );
    }

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}check_free`).setLabel("Check Free Carry").setStyle(ButtonStyle.Secondary)
      )
    );

    const payload = {
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("Carry Request Dashboard")
          .setDescription(
            "Select a carry from the dropdown, then enter amount.\nYou get a weekly free carry (default: 1/week UTC). Use **Check Free Carry** to view your status."
          )
      ],
      components: rows
    };

    if (message) {
      await message.edit(payload).catch(() => {});
      return message;
    }

    message = await channel.send(payload);
    this.db.setBinding("carry_dashboard_message_id", message.id);
    return message;
  }

  async publishCarrierDashboard(channelId = null) {
    const targetId = channelId || this.getCarrierDashboardChannelId();
    if (!targetId || !this.client) return null;

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;

    this.setCarrierDashboardChannelId(channel.id);

    const rows = this.getQueueRows();
    const queueText = rows.length
      ? rows
          .slice(0, 12)
          .map((row, i) => {
            const paidFlag = Number(row.is_paid) ? "[PAID]" : Number(row.is_free) ? "[FREE]" : "[STD]";
            return `${i + 1}. #${row.carry_id} ${paidFlag} ${row.carry_type} ${row.tier} x${row.amount} | <@${row.customer_discord_id}>`;
          })
          .join("\n")
      : "Queue is empty.";

    const payload = {
      embeds: [
        new EmbedBuilder().setColor(0x2ecc71).setTitle("Carrier Dashboard").setDescription(queueText).setFooter({ text: "Use buttons for queue actions." })
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}claim`).setLabel("Claim").setStyle(ButtonStyle.Success)
        )
      ]
    };

    const messageId = this.db.getBinding("carrier_dashboard_message_id", null);
    let message = null;
    if (messageId) message = await channel.messages.fetch(messageId).catch(() => null);

    if (message) {
      await message.edit(payload).catch(() => {});
      return message;
    }

    message = await channel.send(payload);
    this.db.setBinding("carrier_dashboard_message_id", message.id);
    return message;
  }

  computePriorityScore({ isPaid, isFree, member }) {
    const roleScore = this.getRolePriorityScore(member);
    const paidBoost = isPaid ? 1_000_000 : 0;
    const freePenalty = isFree ? -50 : 0;
    return paidBoost + roleScore * 100 + freePenalty;
  }

  async resolveLinkedDiscordByMinecraftUsername(playerUsername) {
    const uuid = await getUUID(playerUsername).catch(() => null);
    if (!uuid) return null;

    try {
      const linked = JSON.parse(readFileSync("data/linked.json", "utf8"));
      const discordId = linked?.[uuid];
      if (!discordId) return null;
      return { uuid, discordId };
    } catch {
      return null;
    }
  }

  createCarryRequest({ guildId, customerUser, member, carryType, tier, amount, isPaid = false, source = "discord" }) {
    if (!this.isQueueEnabled()) {
      return { ok: false, reason: "Carry queue is currently disabled." };
    }

    const normalizedType = String(carryType || "").toLowerCase().trim();
    const normalizedTier = String(tier || "").toLowerCase().trim();
    const qty = Number(amount);

    if (!normalizedType || !normalizedTier || !Number.isInteger(qty) || qty <= 0) {
      return { ok: false, reason: "Invalid carry request payload." };
    }

    const catalog = this.getCatalogItem(normalizedType, normalizedTier);
    if (!catalog || Number(catalog.enabled) !== 1) {
      return { ok: false, reason: "Carry type or tier is not available." };
    }

    const discount = this.discountEngine.calculate({
      unitPrice: Number(catalog.price),
      amount: qty,
      category: catalog.category,
      carryType: normalizedType,
      tier: normalizedTier
    });

    const freeEligible = !isPaid && !!customerUser?.id && this.canUseFreeCarry(customerUser.id);
    const freeReduction = freeEligible ? Number(catalog.price) : 0;

    const finalPrice = Math.max(0, Number((discount.finalTotal - freeReduction).toFixed(2)));
    const totalDiscount = Number((discount.discountTotal + freeReduction).toFixed(2));

    const now = Date.now();
    const tx = this.db.getConnection().transaction(() => {
      let ticketId = null;
      if (this.ticketService && customerUser?.id) {
        const temp = this.db
          .getConnection()
          .prepare(
            `INSERT INTO tickets (guild_id, type, title, status, customer_discord_id, customer_username, created_at, assigned_customer_discord_id)
             VALUES (?, 'manual_carry', ?, 'open', ?, ?, ?, ?)`
          )
          .run(String(guildId || ""), `Carry Request - ${normalizedType} ${normalizedTier}`, customerUser.id, customerUser.tag || customerUser.username, now, customerUser.id);
        ticketId = Number(temp.lastInsertRowid);
      }

      const carryInsert = this.db
        .getConnection()
        .prepare(
          `INSERT INTO carries (
             ticket_id, guild_id, customer_discord_id, customer_mc_username,
             carry_type, tier, category, amount, status,
             base_unit_price, base_total_price, final_price, discount_total,
             is_free, is_paid, price_breakdown_json, requested_at, queued_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ticketId,
          String(guildId || ""),
          customerUser?.id || null,
          null,
          normalizedType,
          normalizedTier,
          catalog.category,
          qty,
          Number(catalog.price),
          discount.baseTotal,
          finalPrice,
          totalDiscount,
          freeEligible ? 1 : 0,
          isPaid ? 1 : 0,
          JSON.stringify({ ...discount, freeReduction }),
          now,
          now
        );

      const carryId = Number(carryInsert.lastInsertRowid);
      const priority = this.computePriorityScore({
        isPaid,
        isFree: freeEligible,
        member
      });

      this.db
        .getConnection()
        .prepare("INSERT INTO queue_entries (carry_id, state, priority_score, created_at) VALUES (?, 'queued', ?, ?)")
        .run(carryId, priority, now);

      if (freeEligible && customerUser?.id) {
        this.consumeFreeCarry(customerUser.id);
      }

      if (ticketId) {
        this.db.logEvent("ticket.created", "ticket", ticketId, {
          source,
          fromCarryRequest: true,
          carryId
        });
      }

      this.db.logEvent("carry.created", "carry", carryId, {
        source,
        finalPrice,
        totalDiscount,
        carryType: normalizedType,
        tier: normalizedTier,
        amount: qty,
        isPaid,
        freeEligible
      });

      return {
        carryId,
        ticketId,
        finalPrice,
        discount,
        freeEligible,
        totalDiscount,
        category: catalog.category
      };
    });

    const created = tx();
    this.ensureTicketThreadAndLog(created.ticketId, created.carryId, customerUser, normalizedType, normalizedTier, qty, created.finalPrice).catch(() => {});
    this.publishCarrierDashboard().catch(() => {});

    const queueDepth = this.getQueueRows().findIndex((row) => Number(row.carry_id) === Number(created.carryId));
    const eta = this.etaEngine.estimate({
      carryType: normalizedType,
      tier: normalizedTier,
      queueDepth: Math.max(0, queueDepth),
      activeCarrierCount: this.getActiveCarrierStats(),
      onlineCarrierCount: this.getEstimatedOnlineCarrierCount(),
      acceptanceRate: this.getAcceptanceRateEstimate()
    });

    return {
      ok: true,
      ...created,
      eta
    };
  }

  async ensureTicketThreadAndLog(ticketId, carryId, customerUser, carryType, tier, amount, finalPrice) {
    if (!ticketId || !this.ticketService) return;
    const thread = await this.ticketService.ensureForumThreadForTicket(ticketId, {
      type: "manual_carry",
      customer: customerUser,
      title: `Carry Request - ${carryType} ${tier}`,
      initialContent: `${carryType} ${tier} x${amount} | Final Price: ${finalPrice}`
    });

    if (thread) {
      this.db.getConnection().prepare("UPDATE carries SET ticket_id = ? WHERE id = ?").run(ticketId, carryId);
    }
  }

  getEstimatedOnlineCarrierCount() {
    if (!this.client) return 1;
    const guild = this.client.guilds.cache.first();
    if (!guild) return 1;
    const carrierRoles = this.getCarrierRoleIds();
    if (carrierRoles.length === 0) return 1;

    let count = 0;
    guild.members.cache.forEach((member) => {
      const hasRole = member.roles.cache.some((role) => carrierRoles.includes(role.id));
      const online = member.presence?.status && member.presence.status !== "offline";
      if (hasRole && online) count += 1;
    });

    return Math.max(1, count);
  }

  getAcceptanceRateEstimate() {
    const row = this.db.getConnection().prepare("SELECT AVG(acceptance_rate) AS avg_rate FROM carrier_stats").get();
    const avg = Number(row?.avg_rate || 0);
    return avg > 0 ? avg : 0.8;
  }

  getCarryById(carryId) {
    return this.db.getConnection().prepare("SELECT * FROM carries WHERE id = ?").get(Number(carryId));
  }

  async claimCarry(carryId, carrierId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (!["queued", "claimed"].includes(carry.status)) return { ok: false, reason: "Carry is not claimable." };

    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    if (!assigned.includes(carrierId)) assigned.push(carrierId);

    this.db
      .getConnection()
      .prepare("UPDATE carries SET status = 'claimed', assigned_carrier_discord_ids = ? WHERE id = ?")
      .run(JSON.stringify(assigned), carry.id);
    this.db
      .getConnection()
      .prepare("UPDATE queue_entries SET state = 'claimed', claimed_at = ?, claimed_by_discord_id = ?, stale_notified = 0 WHERE carry_id = ?")
      .run(Date.now(), carrierId, carry.id);

    this.db.logEvent("carry.claimed", "carry", carry.id, { carrierId });
    await this.publishCarrierDashboard();
    return { ok: true, carryId: carry.id };
  }

  async startCarry(carryId, carrierId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    if (!assigned.includes(carrierId)) {
      assigned.push(carrierId);
    }

    let channelId = carry.execution_channel_id;
    if (!channelId) {
      const created = await this.createExecutionChannel({ carry, carrierIds: assigned });
      if (!created.ok) return created;
      channelId = created.channel.id;
    }

    this.db
      .getConnection()
      .prepare("UPDATE carries SET status = 'in_progress', started_at = COALESCE(started_at, ?), assigned_carrier_discord_ids = ?, execution_channel_id = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify(assigned), channelId, carry.id);

    this.db.logEvent("carry.started", "carry", carry.id, { carrierId, channelId });
    await this.publishCarrierDashboard();
    return { ok: true, carryId: carry.id, channelId };
  }

  async createExecutionChannel({ carry, carrierIds }) {
    if (!this.client) return { ok: false, reason: "Discord client unavailable." };
    const guild = this.client.guilds.cache.get(carry.guild_id) || this.client.guilds.cache.first();
    if (!guild) return { ok: false, reason: "Guild not found." };

    const categoryId = this.getCarryCategoryId();
    const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      return { ok: false, reason: "Carry category is not configured. Use /setup carry-category." };
    }

    const name = `carry-${carry.id}-${String(carry.carry_type).replace(/[^a-z0-9-]/gi, "-").slice(0, 30)}`;

    const staffRoleIds = this.getStaffRoleIds();
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      }
    ];

    if (carry.customer_discord_id) {
      overwrites.push({
        id: carry.customer_discord_id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    for (const id of carrierIds) {
      overwrites.push({
        id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    for (const roleId of staffRoleIds) {
      overwrites.push({
        id: roleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    const channel = await guild.channels
      .create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites
      })
      .catch(() => null);

    if (!channel) {
      return { ok: false, reason: "Failed to create carry execution channel." };
    }

    await channel.send({
      embeds: [this.buildExecutionEmbed(carry)],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}complete_channel:${carry.id}`).setLabel("Complete").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}cancel_channel:${carry.id}`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}customer_confirm:${carry.id}`).setLabel("Customer Confirm").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}ticket_reopen:${carry.id}`).setLabel("Reopen Ticket").setStyle(ButtonStyle.Secondary)
        )
      ]
    });

    return { ok: true, channel };
  }

  buildExecutionEmbed(carry) {
    return new EmbedBuilder()
      .setColor(0x1abc9c)
      .setTitle(`Carry #${carry.id}`)
      .setDescription(`Type: **${carry.carry_type} ${carry.tier}**\nAmount: **${carry.amount}**\nFinal Price: **${carry.final_price}**`)
      .addFields(
        { name: "Customer", value: carry.customer_discord_id ? `<@${carry.customer_discord_id}>` : "Unknown", inline: true },
        { name: "Status", value: carry.status, inline: true },
        { name: "Paid", value: Number(carry.is_paid) ? "Yes" : "No", inline: true }
      );
  }

  async carrierComplete(carryId, carrierId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    this.db.getConnection().prepare("UPDATE carries SET carrier_confirmed = 1 WHERE id = ?").run(carry.id);
    this.db.logEvent("carry.carrier_confirmed", "carry", carry.id, { carrierId });

    const refreshed = this.getCarryById(carry.id);
    if (Number(refreshed.customer_confirmed) === 1) {
      await this.finalizeCarry(refreshed.id);
      return { ok: true, finalized: true };
    }

    this.db.getConnection().prepare("UPDATE carries SET status = 'pending_confirm' WHERE id = ?").run(carry.id);
    return { ok: true, finalized: false };
  }

  async customerConfirm(carryId, customerId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (String(carry.customer_discord_id) !== String(customerId)) {
      return { ok: false, reason: "Only the assigned customer can confirm completion." };
    }

    this.db.getConnection().prepare("UPDATE carries SET customer_confirmed = 1 WHERE id = ?").run(carry.id);
    this.db.logEvent("carry.customer_confirmed", "carry", carry.id, { customerId });

    const refreshed = this.getCarryById(carry.id);
    if (Number(refreshed.carrier_confirmed) === 1) {
      await this.finalizeCarry(refreshed.id);
      return { ok: true, finalized: true };
    }

    this.db.getConnection().prepare("UPDATE carries SET status = 'pending_confirm' WHERE id = ?").run(carry.id);
    return { ok: true, finalized: false };
  }

  async finalizeCarry(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return;

    const now = Date.now();
    this.db
      .getConnection()
      .prepare("UPDATE carries SET status = 'completed', completed_at = ?, customer_confirmed = 1, carrier_confirmed = 1 WHERE id = ?")
      .run(now, carry.id);
    this.db.getConnection().prepare("UPDATE queue_entries SET state = 'completed' WHERE carry_id = ?").run(carry.id);

    const startedAt = Number(carry.started_at || now);
    const duration = Math.max(0, now - startedAt);
    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    for (const carrierId of assigned) {
      this.upsertCarrierStatsOnCompletion(carrierId, duration, true);
    }

    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.closeTicket(carry.ticket_id);
      const transcript = await this.buildChannelTranscript(carry.execution_channel_id);
      if (this.isCarryTranscriptEnabled() && transcript) {
        await this.ticketService.postTranscriptToTicket(carry.ticket_id, transcript);
      }
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carry #${carry.id} completed. Duration: ${Math.round(duration / 60000)}m`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
    }

    await this.closeExecutionChannel(carry.execution_channel_id);
    this.db.logEvent("carry.completed", "carry", carry.id, { duration });
    await this.publishCarrierDashboard();
  }

  upsertCarrierStatsOnCompletion(carrierId, duration, accepted) {
    const now = Date.now();
    const current = this.db.getConnection().prepare("SELECT * FROM carrier_stats WHERE user_id = ?").get(carrierId);
    if (!current) {
      this.db
        .getConnection()
        .prepare(
          "INSERT INTO carrier_stats (user_id, completed_count, total_duration_ms, acceptance_rate, active_hours_json, updated_at) VALUES (?, 1, ?, ?, ?, ?)"
        )
        .run(carrierId, duration, accepted ? 1 : 0, JSON.stringify([new Date(now).getUTCHours()]), now);
      return;
    }

    const completed = Number(current.completed_count || 0) + 1;
    const totalDuration = Number(current.total_duration_ms || 0) + duration;
    const prevRate = Number(current.acceptance_rate || 0.8);
    const nextRate = Math.max(0.1, Math.min(1, prevRate * 0.8 + (accepted ? 1 : 0) * 0.2));
    const hours = new Set(JSON.parse(current.active_hours_json || "[]"));
    hours.add(new Date(now).getUTCHours());

    this.db
      .getConnection()
      .prepare(
        "UPDATE carrier_stats SET completed_count = ?, total_duration_ms = ?, acceptance_rate = ?, active_hours_json = ?, updated_at = ? WHERE user_id = ?"
      )
      .run(completed, totalDuration, nextRate, JSON.stringify([...hours]), now, carrierId);
  }

  async cancelCarry(carryId, actorId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    const now = Date.now();
    this.db.getConnection().prepare("UPDATE carries SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now, carry.id);
    this.db.getConnection().prepare("UPDATE queue_entries SET state = 'cancelled' WHERE carry_id = ?").run(carry.id);

    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carry #${carry.id} cancelled by <@${actorId}>.`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
      await this.ticketService.closeTicket(carry.ticket_id);
    }

    await this.closeExecutionChannel(carry.execution_channel_id);
    this.db.logEvent("carry.cancelled", "carry", carry.id, { actorId });
    await this.publishCarrierDashboard();
    return { ok: true };
  }

  async closeExecutionChannel(channelId) {
    if (!channelId || !this.client) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    await channel.permissionOverwrites
      .edit(channel.guild.roles.everyone.id, {
        SendMessages: false
      })
      .catch(() => {});

    const delayMs = this.getCarryAutoDeleteMs();
    setTimeout(() => {
      channel.delete("Carry closed").catch(() => {});
    }, Math.max(10000, delayMs));
  }

  async buildChannelTranscript(channelId) {
    if (!channelId || !this.client) return "";
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return "";

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return "";

    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    return sorted
      .map((m) => {
        const author = m.member?.displayName || m.author?.username || "unknown";
        const content = (m.content || "[non-text]").replace(/`/g, "'");
        return `[${new Date(m.createdTimestamp).toISOString()}] ${author}: ${content}`;
      })
      .join("\n");
  }

  async checkStaleQueueEntries() {
    if (!this.client) return;
    const minutes = Number(this.db.getBinding("queue_unclaimed_timeout_minutes", 15));
    const threshold = Date.now() - Math.max(1, minutes) * 60 * 1000;

    const stale = this.db
      .getConnection()
      .prepare(
        `SELECT q.carry_id, c.carry_type, c.tier
         FROM queue_entries q
         JOIN carries c ON c.id = q.carry_id
         WHERE q.state = 'queued' AND q.created_at <= ? AND q.stale_notified = 0`
      )
      .all(threshold);

    if (stale.length === 0) return;

    const carrierDashboardId = this.getCarrierDashboardChannelId();
    const channel = carrierDashboardId ? await this.client.channels.fetch(carrierDashboardId).catch(() => null) : null;

    const staffRole = this.getStaffRoleIds()[0];
    const mention = staffRole ? `<@&${staffRole}>` : "";
    for (const row of stale) {
      this.db.getConnection().prepare("UPDATE queue_entries SET stale_notified = 1 WHERE carry_id = ?").run(row.carry_id);
      this.db.logEvent("queue.stale", "carry", row.carry_id, { minutes });
      if (channel) {
        await channel.send({
          content: `${mention} Carry #${row.carry_id} (${row.carry_type} ${row.tier}) is still unclaimed after ${minutes}m.`
        });
      }
    }
  }

  async markPaid(carryId, actorId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    this.db.getConnection().prepare("UPDATE carries SET is_paid = 1 WHERE id = ?").run(carry.id);
    const priority = this.computePriorityScore({ isPaid: true, isFree: Number(carry.is_free) === 1, member: null });
    this.db.getConnection().prepare("UPDATE queue_entries SET priority_score = ? WHERE carry_id = ? AND state IN ('queued','claimed')").run(priority, carry.id);

    this.db.logEvent("carry.mark_paid", "carry", carry.id, { actorId });
    await this.publishCarrierDashboard();
    return { ok: true };
  }

  parseCarryFromModal(interaction) {
    const carryType = interaction.fields.getTextInputValue("carry_type");
    const tier = interaction.fields.getTextInputValue("tier");
    const amount = Number(interaction.fields.getTextInputValue("amount"));

    return {
      carryType,
      tier,
      amount
    };
  }

  static parseComponent(customId) {
    if (typeof customId !== "string") return null;
    if (!customId.startsWith(CARRY_PREFIX)) return null;
    const payload = customId.slice(CARRY_PREFIX.length);
    const [action, ...parts] = payload.split(":");
    const rawId = parts.length ? parts.join(":") : null;
    const carryId = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;
    return { action, carryId, rawId };
  }

  async handleComponent(interaction) {
    const parsed = CarryService.parseComponent(interaction.customId);
    if (!parsed) return false;

    if (parsed.action === "request") {
      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}request`).setTitle("Request Carry");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("carry_type").setLabel("Carry Type").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tier").setLabel("Tier").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("Amount").setStyle(TextInputStyle.Short).setRequired(true))
      );
      await interaction.showModal(modal);
      return true;
    }

    if (parsed.action === "select") {
      const selected = interaction.values?.[0];
      const [carryType, tier] = String(selected || "").split("|");
      if (!carryType || !tier) {
        await interaction.reply({ content: "Invalid carry selection.", ephemeral: true });
        return true;
      }

      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}request:${carryType}|${tier}`).setTitle(`Request ${carryType} ${tier}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("amount").setLabel("Amount").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 1")
        )
      );
      await interaction.showModal(modal);
      return true;
    }

    if (parsed.action === "check_free") {
      const userId = interaction.user?.id;
      const limit = this.getFreeCarryLimit();
      const weekKey = this.getWeekKeyUtc();
      const row = this.db.getConnection().prepare("SELECT used_count FROM freecarry_usage WHERE user_id = ? AND week_key = ?").get(String(userId), weekKey);
      const used = Number(row?.used_count || 0);
      const remaining = Math.max(0, limit - used);
      await interaction.reply({
        ephemeral: true,
        content: `Week: \`${weekKey}\`\nFree carries: **${remaining}/${limit}** remaining (${used} used).`
      });
      return true;
    }

    if (["claim", "start", "complete", "cancel", "mark_paid"].includes(parsed.action) && parsed.carryId === null) {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can perform this action.", ephemeral: true });
        return true;
      }

      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}${parsed.action}`).setTitle(`${parsed.action} Carry`);
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("carry_id").setLabel("Carry ID").setStyle(TextInputStyle.Short).setRequired(true)));
      await interaction.showModal(modal);
      return true;
    }

    if (parsed.action === "complete_channel") {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can complete carries.", ephemeral: true });
        return true;
      }

      const result = await this.carrierComplete(parsed.carryId, interaction.user.id);
      await interaction.reply({
        content: result.ok ? (result.finalized ? `Carry #${parsed.carryId} completed.` : `Carrier completion recorded for carry #${parsed.carryId}. Waiting for customer confirmation.`) : result.reason,
        ephemeral: true
      });
      return true;
    }

    if (parsed.action === "cancel_channel") {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can cancel carries.", ephemeral: true });
        return true;
      }

      const result = await this.cancelCarry(parsed.carryId, interaction.user.id);
      await interaction.reply({ content: result.ok ? `Carry #${parsed.carryId} cancelled.` : result.reason, ephemeral: true });
      return true;
    }

    if (parsed.action === "customer_confirm") {
      const result = await this.customerConfirm(parsed.carryId, interaction.user.id);
      await interaction.reply({
        content: result.ok ? (result.finalized ? `Carry #${parsed.carryId} confirmed and completed.` : `Customer confirmation recorded. Waiting for carrier completion.`) : result.reason,
        ephemeral: true
      });
      return true;
    }

    if (parsed.action === "ticket_reopen") {
      const carry = this.getCarryById(parsed.carryId);
      if (!carry?.ticket_id) {
        await interaction.reply({ content: "No linked ticket found.", ephemeral: true });
        return true;
      }

      this.db.getConnection().prepare("UPDATE tickets SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1 WHERE id = ?").run(carry.ticket_id);
      await interaction.reply({ content: `Ticket #${carry.ticket_id} reopened by staff flow.`, ephemeral: true });
      return true;
    }

    return false;
  }

  async handleModal(interaction) {
    if (!interaction.customId?.startsWith(CARRY_MODAL_PREFIX)) return false;

    const action = interaction.customId.slice(CARRY_MODAL_PREFIX.length);
    if (action.startsWith("request")) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      let carryType = null;
      let tier = null;
      let amount = null;

      if (action.includes(":")) {
        const encoded = action.split(":").slice(1).join(":");
        [carryType, tier] = String(encoded || "").split("|");
        amount = Number(interaction.fields.getTextInputValue("amount"));
      } else {
        const parsed = this.parseCarryFromModal(interaction);
        carryType = parsed.carryType;
        tier = parsed.tier;
        amount = parsed.amount;
      }

      const created = this.createCarryRequest({
        guildId: interaction.guildId,
        customerUser: interaction.user,
        member: interaction.member,
        carryType,
        tier,
        amount,
        source: "dashboard"
      });

      if (!created.ok) {
        await interaction.editReply({ content: created.reason });
        return true;
      }

      const mins = Math.max(1, Math.round(created.eta.etaMs / 60000));
      const breakdown = created.discount;
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle(`Carry Request #${created.carryId}`)
            .setDescription("Queued successfully.")
            .addFields(
              { name: "Base Price", value: `${breakdown.baseTotal}`, inline: true },
              { name: "Discount", value: `${created.totalDiscount}`, inline: true },
              { name: "Final", value: `${created.finalPrice}`, inline: true },
              { name: "ETA", value: `~${mins} min`, inline: true },
              { name: "Free Carry", value: created.freeEligible ? "Applied (weekly)" : "Not available this week", inline: true }
            )
        ]
      });

      return true;
    }

    if (!["claim", "start", "complete", "cancel", "mark_paid"].includes(action)) {
      return false;
    }

    if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
      await interaction.reply({ content: "Only carriers/staff can perform this action.", ephemeral: true });
      return true;
    }

    const carryId = Number(interaction.fields.getTextInputValue("carry_id"));
    if (!Number.isInteger(carryId) || carryId <= 0) {
      await interaction.reply({ content: "Invalid carry ID.", ephemeral: true });
      return true;
    }

    let result = null;
    if (action === "claim") result = await this.claimCarry(carryId, interaction.user.id);
    if (action === "start") result = await this.startCarry(carryId, interaction.user.id);
    if (action === "complete") result = await this.carrierComplete(carryId, interaction.user.id);
    if (action === "cancel") result = await this.cancelCarry(carryId, interaction.user.id);
    if (action === "mark_paid") result = await this.markPaid(carryId, interaction.user.id);

    const message = result?.ok ? (action === "start" && result.channelId ? `Carry #${carryId} started in <#${result.channelId}>.` : `Action \`${action}\` applied on carry #${carryId}.`) : result?.reason || "Action failed.";

    await interaction.reply({ content: message, ephemeral: true });
    return true;
  }

  createCarryFromMinecraft({ playerUsername, carryType, amount }) {
    return this.resolveLinkedDiscordByMinecraftUsername(playerUsername).then(async (linked) => {
      if (!linked) {
        return { ok: false, reason: "Your Minecraft account is not linked to Discord. Use /verify first." };
      }

      const tier = "1";
      const user = await this.client.users.fetch(linked.discordId).catch(() => null);
      if (!user) {
        return { ok: false, reason: "Linked Discord account was not found in this server." };
      }

      const guild = this.client.guilds.cache.first();
      const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
      const created = this.createCarryRequest({ guildId: guild?.id, customerUser: user, member, carryType, tier, amount, source: "minecraft" });

      if (!created.ok) return created;
      return {
        ok: true,
        carryId: created.carryId,
        etaMs: created.eta.etaMs,
        finalPrice: created.finalPrice
      };
    });
  }

  setQueueUnclaimedTimeout(minutes) {
    this.db.setBinding("queue_unclaimed_timeout_minutes", Number(minutes));
  }

  addDiscountRule(rule) {
    const now = Date.now();
    const result = this.db
      .getConnection()
      .prepare(
        `INSERT INTO discount_rules (kind, scope, category, carry_type, tier, min_amount, percentage, starts_at, ends_at, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(rule.kind, rule.scope, rule.category || null, rule.carryType || null, rule.tier || null, rule.minAmount ?? null, Number(rule.percentage), rule.startsAt ?? null, rule.endsAt ?? null, now);

    return Number(result.lastInsertRowid);
  }

  removeStaticDiscountByAmount(amount) {
    return this.db
      .getConnection()
      .prepare("DELETE FROM discount_rules WHERE kind = 'static' AND scope = 'global' AND min_amount = ?")
      .run(Number(amount)).changes;
  }

  formatPricePreview(type, tier, amount) {
    const catalog = this.getCatalogItem(type, tier);
    if (!catalog) return null;

    const breakdown = this.discountEngine.calculate({
      unitPrice: Number(catalog.price),
      amount: Number(amount),
      category: catalog.category,
      carryType: type,
      tier
    });

    return {
      base: breakdown.baseTotal,
      discount: breakdown.discountTotal,
      final: breakdown.finalTotal,
      scopeDiscount: breakdown.scopeDiscount,
      bulkDiscount: breakdown.bulkDiscount
    };
  }
}

module.exports = {
  CarryService,
  CARRY_PREFIX,
  CARRY_MODAL_PREFIX
};
