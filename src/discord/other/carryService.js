
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  OverwriteType,
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
    this.reconcileMissingCarryArtifacts().catch(() => {});
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
      this.reconcileMissingCarryArtifacts().catch(() => {});
      this.sampleCarrierOnlineCount().catch(() => {});
    }, 60000);
  }

  async reconcileMissingCarryArtifacts() {
    const stats = { checked: 0, threadBackfilled: 0, channelBackfilled: 0, errors: 0, errorDetails: [] };
    if (!this.client) return stats;
    const openCarries = this.db
      .getConnection()
      .prepare(
        `SELECT c.*,
                t.forum_thread_id AS ticket_forum_thread_id
         FROM carries c
         LEFT JOIN tickets t ON t.id = c.ticket_id
         WHERE c.status IN ('queued', 'claimed', 'in_progress', 'pending_confirm')`
      )
      .all();

    for (const carry of openCarries) {
      stats.checked += 1;
      if (carry.ticket_id && !carry.ticket_forum_thread_id) {
        const pseudoUser = carry.customer_discord_id
          ? { id: String(carry.customer_discord_id), username: "customer", tag: "customer" }
          : null;
        const before = this.getCarryById(carry.id);
        await this.ensureTicketThreadAndLog(
          Number(carry.ticket_id),
          Number(carry.id),
          pseudoUser,
          carry.carry_type,
          carry.tier,
          Number(carry.amount),
          Number(carry.final_price)
        ).catch((error) => {
          stats.errors += 1;
          if (stats.errorDetails.length < 5) {
            stats.errorDetails.push(`carry#${carry.id} ticket-thread: ${error?.message || String(error)}`);
          }
        });
        const afterTicket = before?.ticket_id ? this.db.getConnection().prepare("SELECT forum_thread_id FROM tickets WHERE id = ?").get(before.ticket_id) : null;
        if (afterTicket?.forum_thread_id) {
          stats.threadBackfilled += 1;
        }
      }

      if (!carry.execution_channel_id) {
        const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
        const created = await this.createExecutionChannel({ carry, carrierIds: assigned }).catch((error) => ({ ok: false, reason: error?.message || String(error) }));
        if (created?.ok && created.channel?.id) {
          this.db
            .getConnection()
            .prepare("UPDATE carries SET execution_channel_id = ? WHERE id = ?")
            .run(created.channel.id, carry.id);
          this.db.logEvent("carry.execution_channel_backfill", "carry", carry.id, { channelId: created.channel.id });
          stats.channelBackfilled += 1;
        } else {
          stats.errors += 1;
          if (stats.errorDetails.length < 5) {
            stats.errorDetails.push(`carry#${carry.id} execution-channel: ${created?.reason || "unknown failure"}`);
          }
          this.db.logEvent("carry.execution_channel_backfill_failed", "carry", carry.id, {
            reason: created?.reason || "unknown failure",
            carryCategoryId: this.getCarryCategoryId()
          });
        }
      } else {
        const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
        await this.ensureExecutionChannelAccess(carry.execution_channel_id, carry, assigned).catch((error) => {
          stats.errors += 1;
          if (stats.errorDetails.length < 5) {
            stats.errorDetails.push(`carry#${carry.id} execution-access: ${error?.message || String(error)}`);
          }
        });
      }
    }

    return stats;
  }

  seedDefaultCatalog() {
    const db = this.db.getConnection();
    const defaults = [
      ["dungeons", "f1", "dungeons", 200000],
      ["dungeons", "f2", "dungeons", 200000],
      ["dungeons", "f3", "dungeons", 200000],
      ["dungeons", "f4", "dungeons", 700000],
      ["dungeons", "f5", "dungeons", 600000],
      ["dungeons", "f6", "dungeons", 800000],
      ["dungeons", "f7", "dungeons", 8000000],
      ["dungeons", "m1", "dungeons", 1000000],
      ["dungeons", "m2", "dungeons", 1500000],
      ["dungeons", "m3", "dungeons", 2000000],
      ["dungeons", "m4", "dungeons", 10000000],
      ["dungeons", "m5", "dungeons", 5000000],
      ["dungeons", "m6", "dungeons", 6000000],
      ["dungeons", "m7", "dungeons", 30000000],
      ["slayer_zombie", "1", "slayers", 200000],
      ["slayer_zombie", "2", "slayers", 200000],
      ["slayer_zombie", "3", "slayers", 200000],
      ["slayer_zombie", "4", "slayers", 200000],
      ["slayer_zombie", "5", "slayers", 800000],
      ["slayer_tara", "1", "slayers", 0],
      ["slayer_tara", "2", "slayers", 0],
      ["slayer_tara", "3", "slayers", 0],
      ["slayer_tara", "4", "slayers", 0],
      ["slayer_tara", "5", "slayers", 0],
      ["slayer_sven", "1", "slayers", 200000],
      ["slayer_sven", "2", "slayers", 200000],
      ["slayer_sven", "3", "slayers", 200000],
      ["slayer_sven", "4", "slayers", 500000],
      ["slayer_eman", "1", "slayers", 200000],
      ["slayer_eman", "2", "slayers", 200000],
      ["slayer_eman", "3", "slayers", 500000],
      ["slayer_eman", "4", "slayers", 1500000],
      ["slayer_blaze", "1", "slayers", 500000],
      ["slayer_blaze", "2", "slayers", 1000000],
      ["slayer_blaze", "3", "slayers", 2000000],
      ["slayer_blaze", "4", "slayers", 4000000],
      ["slayer_blaze", "5", "slayers", 0],
      ["kuudra", "basic", "kuudra", 6000000],
      ["kuudra", "hot", "kuudra", 10000000],
      ["kuudra", "burning", "kuudra", 15000000],
      ["kuudra", "fiery", "kuudra", 20000000],
      ["kuudra", "infernal", "kuudra", 45000000]
    ];

    const insert = db.prepare(
      "INSERT INTO carry_catalog (carry_type, tier, category, price, enabled) VALUES (?, ?, ?, 0, 1) ON CONFLICT(carry_type, tier) DO NOTHING"
    );
    const updateIfUnset = db.prepare("UPDATE carry_catalog SET price = ? WHERE lower(carry_type)=lower(?) AND lower(tier)=lower(?) AND (price IS NULL OR price <= 0)");

    const tx = db.transaction(() => {
      for (const row of defaults) {
        insert.run(row[0], row[1], row[2]);
        if (Number(row[3] || 0) > 0) {
          updateIfUnset.run(Number(row[3]), row[0], row[1]);
        }
      }
    });
    tx();
  }

  getCarrierRoleIds() {
    const bound = this.db.getBinding("carrier_claim_role_id", null);
    if (bound && /^\d{17,20}$/.test(String(bound))) {
      return [String(bound)];
    }

    return (config.discord?.carry?.carrierRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id)));
  }

  setCarrierClaimRoleId(roleId) {
    if (!roleId) {
      this.db.setBinding("carrier_claim_role_id", null);
      return;
    }

    this.db.setBinding("carrier_claim_role_id", String(roleId));
  }

  getCarrierClaimRoleId() {
    const bound = this.db.getBinding("carrier_claim_role_id", null);
    return bound && /^\d{17,20}$/.test(String(bound)) ? String(bound) : null;
  }

  getStaffRoleIds() {
    const configured = (config.discord?.tickets?.staffRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id)));
    if (configured.length) return configured;
    const fallback = config.discord?.commands?.commandRole;
    return /^\d{17,20}$/.test(String(fallback || "")) ? [String(fallback)] : [];
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

  setCarrierStatsChannelId(channelId) {
    this.db.setBinding("carrier_stats_channel_id", channelId);
  }

  getCarrierStatsChannelId() {
    return this.db.getBinding("carrier_stats_channel_id", config.discord?.carry?.carrierStatsChannelId || null);
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

  sanitizeNamePart(value, fallback) {
    const clean = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return clean || fallback;
  }

  buildCarryDisplayName({ type, amount, name }) {
    const typePart = String(type || "carry").trim();
    const amountPart = String(amount || "-").trim();
    const namePart = String(name || "customer").trim();
    return `├:tickets: 》${typePart}-${amountPart}-${namePart}`.slice(0, 100);
  }

  sanitizeTextChannelName(name, fallback = "carry-ticket") {
    const clean = String(name || "")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 95);
    return clean || fallback;
  }

  formatCoinsShort(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "0";
    const abs = Math.abs(n);
    if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}b`;
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
    if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
    return String(Math.round(n));
  }

  getFreeCarryBonus(userId) {
    if (!userId) return 0;
    const row = this.db.getConnection().prepare("SELECT remaining_count FROM freecarry_bonus WHERE user_id = ?").get(String(userId));
    return Math.max(0, Number(row?.remaining_count || 0));
  }

  grantFreeCarryBonus(userId, amount) {
    const cleanAmount = Number(amount);
    if (!userId || !Number.isInteger(cleanAmount) || cleanAmount <= 0) {
      return { ok: false, reason: "Invalid user or amount." };
    }

    const now = Date.now();
    this.db
      .getConnection()
      .prepare(
        `INSERT INTO freecarry_bonus (user_id, remaining_count, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id)
         DO UPDATE SET remaining_count = remaining_count + excluded.remaining_count, updated_at = excluded.updated_at`
      )
      .run(String(userId), cleanAmount, now);
    const remaining = this.getFreeCarryBonus(userId);
    this.db.logEvent("freecarry.bonus_granted", "user", String(userId), { amount: cleanAmount, remaining });
    return { ok: true, remaining };
  }

  getWeekKeyUtc(ts = Date.now()) {
    const date = new Date(ts);
    const year = date.getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, 1));
    const diffDays = Math.floor((date - start) / 86400000);
    const week = Math.floor(diffDays / 7) + 1;
    return `${year}-W${String(week).padStart(2, "0")}`;
  }

  getFreeCarryStatus(userId) {
    if (!userId) {
      return {
        weekKey: this.getWeekKeyUtc(),
        limit: this.getFreeCarryLimit(),
        used: 0,
        weeklyRemaining: 0,
        bonusRemaining: 0,
        totalRemaining: 0,
        eligible: false,
        source: null
      };
    }

    const weekKey = this.getWeekKeyUtc();
    const limit = this.getFreeCarryLimit();
    const row = this.db.getConnection().prepare("SELECT used_count FROM freecarry_usage WHERE user_id = ? AND week_key = ?").get(String(userId), weekKey);
    const used = Number(row?.used_count || 0);
    const weeklyRemaining = Math.max(0, limit - used);
    const bonusRemaining = this.getFreeCarryBonus(userId);
    const totalRemaining = weeklyRemaining + bonusRemaining;
    return {
      weekKey,
      limit,
      used,
      weeklyRemaining,
      bonusRemaining,
      totalRemaining,
      eligible: totalRemaining > 0,
      source: weeklyRemaining > 0 ? "weekly" : bonusRemaining > 0 ? "bonus" : null
    };
  }

  canUseFreeCarry(userId) {
    return this.getFreeCarryStatus(userId).eligible;
  }

  consumeFreeCarry(userId) {
    const status = this.getFreeCarryStatus(userId);
    if (!status.eligible) {
      return { ok: false, source: null };
    }

    if (status.weeklyRemaining > 0) {
      this.db
        .getConnection()
        .prepare(
          `INSERT INTO freecarry_usage (user_id, week_key, used_count)
           VALUES (?, ?, 1)
           ON CONFLICT(user_id, week_key)
           DO UPDATE SET used_count = used_count + 1`
        )
        .run(String(userId), status.weekKey);
      return { ok: true, source: "weekly" };
    }

    if (status.bonusRemaining > 0) {
      this.db
        .getConnection()
        .prepare("UPDATE freecarry_bonus SET remaining_count = MAX(0, remaining_count - 1), updated_at = ? WHERE user_id = ?")
        .run(Date.now(), String(userId));
      return { ok: true, source: "bonus" };
    }

    return { ok: false, source: null };
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
        description: `Price: ${this.formatCoinsShort(item.price)} each`.slice(0, 100),
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

    if (message && typeof message.edit === "function") {
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

    const components = [];
    if (rows.length > 0) {
      const options = rows.slice(0, 25).map((row) => {
        const paidFlag = Number(row.is_paid) ? "PAID" : Number(row.is_free) ? "FREE" : "STD";
        return {
          label: `#${row.carry_id} ${row.carry_type} ${row.tier} x${row.amount}`.slice(0, 100),
          description: `${paidFlag} | prio ${Math.round(Number(row.priority_score || 0))}`.slice(0, 100),
          value: String(row.carry_id)
        };
      });
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`${CARRY_PREFIX}carrier_pick`)
            .setPlaceholder("Choose a carry to claim")
            .addOptions(options)
        )
      );
    }

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}claim`).setLabel("Claim by ID").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}carrier_refresh`).setLabel("Refresh").setStyle(ButtonStyle.Secondary)
      )
    );

    const payload = {
      embeds: [
        new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle("Carrier Dashboard")
          .setDescription(queueText)
          .setFooter({ text: "Use dropdown for quick claim, or Claim by ID." })
      ],
      components
    };

    const messageId = this.db.getBinding("carrier_dashboard_message_id", null);
    let message = null;
    if (messageId) message = await channel.messages.fetch(messageId).catch(() => null);

    if (message && typeof message.edit === "function") {
      await message.edit(payload).catch(() => {});
      return message;
    }

    message = await channel.send(payload);
    this.db.setBinding("carrier_dashboard_message_id", message.id);
    return message;
  }

  async publishCarrierStatsDashboard(channelId = null) {
    const targetId = channelId || this.getCarrierStatsChannelId();
    if (!targetId || !this.client) return null;

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;

    this.setCarrierStatsChannelId(channel.id);

    const rows = this.db
      .getConnection()
      .prepare(
        `SELECT cs.user_id,
                cs.completed_count,
                cs.total_duration_ms,
                cs.acceptance_rate,
                COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM customer_ratings r
                         JOIN carries c ON c.id = r.carry_id
                         WHERE c.assigned_carrier_discord_ids LIKE '%' || cs.user_id || '%'), 0) AS avg_rating
         FROM carrier_stats cs
         ORDER BY cs.completed_count DESC, cs.updated_at DESC
         LIMIT 15`
      )
      .all();

    const description =
      rows.length === 0
        ? "No carrier stats yet."
        : rows
            .map((row, i) => {
              const avgMinutes = row.completed_count > 0 ? Math.round(Number(row.total_duration_ms || 0) / Number(row.completed_count) / 60000) : 0;
              const acceptance = Math.round(Number(row.acceptance_rate || 0) * 100);
              const rating = Number(row.avg_rating || 0);
              return `${i + 1}. <@${row.user_id}> | done: **${row.completed_count}** | avg: **${avgMinutes}m** | accept: **${acceptance}%** | rating: **${rating || "-"}**`;
            })
            .join("\n");

    const payload = {
      embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle("Carrier Stats").setDescription(description)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${CARRY_PREFIX}stats_refresh`).setLabel("Refresh").setStyle(ButtonStyle.Secondary))]
    };

    const messageId = this.db.getBinding("carrier_stats_message_id", null);
    let message = null;
    if (messageId) message = await channel.messages.fetch(messageId).catch(() => null);

    if (message && typeof message.edit === "function") {
      await message.edit(payload).catch(() => {});
      return message;
    }

    message = await channel.send(payload);
    this.db.setBinding("carrier_stats_message_id", message.id);
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

    const freeStatus = !isPaid && !!customerUser?.id ? this.getFreeCarryStatus(customerUser.id) : null;
    const freeEligible = !isPaid && !!freeStatus?.eligible;
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

      let freeSource = null;
      if (freeEligible && customerUser?.id) {
        const consumed = this.consumeFreeCarry(customerUser.id);
        freeSource = consumed.source || freeStatus?.source || null;
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
        freeEligible,
        freeSource
      });

      return {
        carryId,
        ticketId,
        finalPrice,
        discount,
        freeEligible,
        freeSource,
        totalDiscount,
        category: catalog.category
      };
    });

    const created = tx();
    this.ensureTicketThreadAndLog(created.ticketId, created.carryId, customerUser, normalizedType, normalizedTier, qty, created.finalPrice).catch(() => {});
    this.ghostPingCarrierRole(created.carryId).catch(() => {});
    const createdCarry = this.getCarryById(created.carryId);
    if (createdCarry && !createdCarry.execution_channel_id) {
      this.createExecutionChannel({ carry: createdCarry, carrierIds: [] })
        .then((res) => {
          if (res?.ok && res.channel?.id) {
            this.db.getConnection().prepare("UPDATE carries SET execution_channel_id = ? WHERE id = ?").run(res.channel.id, created.carryId);
          }
        })
        .catch(() => {});
    }
    this.publishCarrierDashboard().catch(() => {});
    this.syncCarryTicketIndicators(created.carryId).catch(() => {});

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
      initialContent: this.buildCarryPricingSummaryText(carryId, carryType, tier, amount, finalPrice)
    });

    if (thread) {
      this.db.getConnection().prepare("UPDATE carries SET ticket_id = ? WHERE id = ?").run(ticketId, carryId);
      await this.syncCarryTicketIndicators(carryId).catch(() => {});
      return;
    }

    this.db.logEvent("carry.ticket_thread_missing", "carry", carryId, { ticketId });
    const dashboardId = this.getCarrierDashboardChannelId();
    if (dashboardId && this.client) {
      const channel = await this.client.channels.fetch(dashboardId).catch(() => null);
      if (channel && typeof channel.send === "function") {
        const staffRole = this.getStaffRoleIds()[0];
        const mention = staffRole ? `<@&${staffRole}> ` : "";
        await channel
          .send({
            content: `${mention}Carry #${carryId} created but no ticket forum thread was created. Check \`/setup ticket-logs\` and forum permissions.`
          })
          .catch(() => {});
      }
    }
  }

  async ghostPingCarrierRole(carryId) {
    const roleId = this.getCarrierClaimRoleId() || this.getCarrierRoleIds()[0];
    const channelId = this.getCarrierDashboardChannelId();
    if (!roleId || !channelId || !this.client) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") return;

    const message = await channel.send({ content: `<@&${roleId}> Carry #${carryId} is waiting in queue.` }).catch(() => null);
    if (!message) return;
    setTimeout(() => {
      message.delete().catch(() => {});
    }, 1500);
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

  async sampleCarrierOnlineCount() {
    const now = Date.now();
    const onlineCount = this.getEstimatedOnlineCarrierCount();
    this.db.getConnection().prepare("INSERT INTO carrier_online_samples (sampled_at, online_count) VALUES (?, ?)").run(now, Number(onlineCount));
    const trimBefore = now - 14 * 24 * 60 * 60 * 1000;
    this.db.getConnection().prepare("DELETE FROM carrier_online_samples WHERE sampled_at < ?").run(trimBefore);
  }

  hadCarrierOnlineBetween(fromTs, toTs) {
    const row = this.db
      .getConnection()
      .prepare("SELECT 1 AS ok FROM carrier_online_samples WHERE sampled_at >= ? AND sampled_at <= ? AND online_count > 0 LIMIT 1")
      .get(Number(fromTs || 0), Number(toTs || Date.now()));
    return !!row?.ok;
  }

  getAcceptanceRateEstimate() {
    const row = this.db.getConnection().prepare("SELECT AVG(acceptance_rate) AS avg_rate FROM carrier_stats").get();
    const avg = Number(row?.avg_rate || 0);
    return avg > 0 ? avg : 0.8;
  }

  getCarryById(carryId) {
    return this.db.getConnection().prepare("SELECT * FROM carries WHERE id = ?").get(Number(carryId));
  }

  async syncCarryTicketIndicators(carryId) {
    if (!this.ticketService) return;
    const carry = this.getCarryById(carryId);
    if (!carry?.ticket_id) return;
    await this.ticketService.syncCarryThreadIndicators(carry.ticket_id, carry).catch(() => {});
  }

  async ensureExecutionChannelAccess(channelId, carry, carrierIds = []) {
    if (!channelId || !this.client) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const overwrite = {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    };

    const targets = new Set();
    if (carry?.customer_discord_id) targets.add(String(carry.customer_discord_id));
    for (const id of carrierIds) {
      if (id) targets.add(String(id));
    }

    for (const id of targets) {
      await channel.permissionOverwrites.edit(id, overwrite).catch(() => {});
    }
  }

  async claimCarry(carryId, carrierId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (!["queued", "claimed"].includes(carry.status)) return { ok: false, reason: "Carry is not claimable." };

    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    if (!assigned.includes(carrierId)) assigned.push(carrierId);

    this.db.getConnection().prepare("UPDATE carries SET status = 'claimed', assigned_carrier_discord_ids = ? WHERE id = ?").run(JSON.stringify(assigned), carry.id);
    this.db
      .getConnection()
      .prepare("UPDATE queue_entries SET state = 'claimed', claimed_at = ?, claimed_by_discord_id = ?, stale_notified = 0 WHERE carry_id = ?")
      .run(Date.now(), carrierId, carry.id);

    if (carry.execution_channel_id) {
      await this.ensureExecutionChannelAccess(carry.execution_channel_id, carry, assigned);
    }

    this.db.logEvent("carry.claimed", "carry", carry.id, { carrierId });
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    await this.refreshExecutionPanel(carry.id).catch(() => {});
    return { ok: true, carryId: carry.id };
  }

  async unclaimCarry(carryId, carrierId, allowOverride = false) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (!["queued", "claimed", "in_progress"].includes(String(carry.status))) return { ok: false, reason: "Carry is not claimable." };

    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    if (!assigned.includes(String(carrierId)) && !allowOverride) {
      return { ok: false, reason: "Only assigned carrier can unclaim this carry." };
    }

    const nextAssigned = assigned.filter((id) => String(id) !== String(carrierId));
    const nextStatus = nextAssigned.length > 0 ? "claimed" : "queued";
    this.db
      .getConnection()
      .prepare("UPDATE carries SET status = ?, assigned_carrier_discord_ids = ? WHERE id = ?")
      .run(nextStatus, JSON.stringify(nextAssigned), carry.id);
    this.db
      .getConnection()
      .prepare("UPDATE queue_entries SET state = ?, claimed_by_discord_id = CASE WHEN ? THEN claimed_by_discord_id ELSE NULL END WHERE carry_id = ?")
      .run(nextStatus, nextAssigned.length > 0 ? 1 : 0, carry.id);
    this.db.logEvent("carry.unclaimed", "carry", carry.id, { carrierId });
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    await this.refreshExecutionPanel(carry.id).catch(() => {});
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
    } else {
      await this.ensureExecutionChannelAccess(channelId, carry, assigned);
    }

    this.db
      .getConnection()
      .prepare("UPDATE carries SET status = 'in_progress', started_at = COALESCE(started_at, ?), assigned_carrier_discord_ids = ?, execution_channel_id = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify(assigned), channelId, carry.id);

    this.db.logEvent("carry.started", "carry", carry.id, { carrierId, channelId });
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    return { ok: true, carryId: carry.id, channelId };
  }

  async createExecutionChannel({ carry, carrierIds }) {
    if (!this.client) return { ok: false, reason: "Discord client unavailable." };
    const guild = this.client.guilds.cache.get(carry.guild_id) || this.client.guilds.cache.first();
    if (!guild) return { ok: false, reason: "Guild not found." };

    const categoryId = this.getCarryCategoryId();
    const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
    const parentId = category && category.type === ChannelType.GuildCategory ? category.id : null;
    if (categoryId && !parentId) {
      this.db.logEvent("carry.execution_channel_category_fallback", "carry", carry.id, {
        categoryId,
        reason: "Configured category could not be fetched as GuildCategory; creating in guild root."
      });
    }

    const typeLabel = `${carry.carry_type || "carry"} ${carry.tier || ""}`.trim();
    const displayName = this.buildCarryDisplayName({
      type: typeLabel,
      amount: carry.amount || "-",
      name: carry.customer_username || "customer"
    });
    const name = this.sanitizeTextChannelName(displayName);

    const staffRoleIds = this.getStaffRoleIds();
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionsBitField.Flags.ViewChannel]
      }
    ];

    if (carry.customer_discord_id) {
      overwrites.push({
        id: carry.customer_discord_id,
        type: OverwriteType.Member,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    for (const id of carrierIds) {
      overwrites.push({
        id,
        type: OverwriteType.Member,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    for (const roleId of staffRoleIds) {
      overwrites.push({
        id: roleId,
        type: OverwriteType.Role,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    const channel = await guild.channels
      .create({
        name,
        type: ChannelType.GuildText,
        parent: parentId,
        topic: displayName,
        permissionOverwrites: overwrites
      })
      .catch((error) => ({ __error: error }));

    if (!channel || channel.__error) {
      return {
        ok: false,
        reason: `Failed to create carry execution channel${channel?.__error?.message ? `: ${channel.__error.message}` : "."}`
      };
    }

    const panelMessage = await channel.send({
      embeds: [this.buildExecutionEmbed(carry)],
      components: this.buildExecutionComponents(carry)
    });
    this.db.getConnection().prepare("UPDATE carries SET execution_message_id = ? WHERE id = ?").run(panelMessage.id, carry.id);

    return { ok: true, channel };
  }

  buildExecutionEmbed(carry) {
    const breakdown = this.safePriceBreakdown(carry?.price_breakdown_json);
    const scopePct = Number(breakdown?.scopeDiscount?.percentage || 0);
    const bulkPct = Number(breakdown?.bulkDiscount?.percentage || 0);
    const freeReduction = Number(breakdown?.freeReduction || 0);
    const scopeLabel = scopePct > 0 ? `${scopePct}% (${breakdown?.scopeDiscount?.scope || "scope"})` : "None";
    const bulkLabel = bulkPct > 0 ? `${bulkPct}%` : "None";
    const freeLabel = Number(carry?.is_free) === 1 || freeReduction > 0 ? `Yes (-${this.formatCoinsShort(freeReduction || 0)})` : "No";

    return new EmbedBuilder()
      .setColor(0x1abc9c)
      .setTitle(`Carry #${carry.id}`)
      .setDescription(`Type: **${carry.carry_type} ${carry.tier}**\nAmount: **${carry.amount}**\nFinal Price: **${this.formatCoinsShort(carry.final_price)}**`)
      .addFields(
        { name: "Customer", value: carry.customer_discord_id ? `<@${carry.customer_discord_id}>` : "Unknown", inline: true },
        { name: "Status", value: carry.status, inline: true },
        { name: "Paid Amount", value: `${this.formatCoinsShort(carry.paid_amount || 0)}`, inline: true },
        { name: "Logged Runs", value: `${Number(carry.logged_runs || 0)}/${Number(carry.amount || 0)}`, inline: true },
        { name: "Base", value: `${this.formatCoinsShort(breakdown?.baseTotal ?? carry.base_total_price ?? 0)}`, inline: true },
        { name: "Scope Discount", value: scopeLabel, inline: true },
        { name: "Bulk Discount", value: bulkLabel, inline: true },
        { name: "Free Carry Used", value: freeLabel, inline: true }
      );
  }

  buildExecutionComponents(carry) {
    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    const claimBtn =
      assigned.length > 0
        ? new ButtonBuilder().setCustomId(`${CARRY_PREFIX}unclaim:${carry.id}`).setLabel("Unclaim").setStyle(ButtonStyle.Secondary)
        : new ButtonBuilder().setCustomId(`${CARRY_PREFIX}claim:${carry.id}`).setLabel("Claim").setStyle(ButtonStyle.Primary);

    return [
      new ActionRowBuilder().addComponents(
        claimBtn,
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}close_ticket:${carry.id}`).setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}mark_paid:${carry.id}`).setLabel("Mark Paid").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}log_runs:${carry.id}`).setLabel("Log Runs").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${CARRY_PREFIX}reping:${carry.id}`).setLabel("Reping").setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  async refreshExecutionPanel(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry?.execution_channel_id || !carry?.execution_message_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const message = await channel.messages.fetch(carry.execution_message_id).catch(() => null);
    if (!message) return;
    await message.edit({ embeds: [this.buildExecutionEmbed(carry)], components: this.buildExecutionComponents(carry) }).catch(() => {});
  }

  safePriceBreakdown(raw) {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  buildCarryPricingSummaryText(carryId, carryType, tier, amount, finalPrice) {
    const carry = carryId ? this.getCarryById(carryId) : null;
    const breakdown = this.safePriceBreakdown(carry?.price_breakdown_json);
    const baseTotal = breakdown?.baseTotal ?? carry?.base_total_price ?? 0;
    const scopePct = Number(breakdown?.scopeDiscount?.percentage || 0);
    const scopeScope = breakdown?.scopeDiscount?.scope || "scope";
    const bulkPct = Number(breakdown?.bulkDiscount?.percentage || 0);
    const freeReduction = Number(breakdown?.freeReduction || 0);
    const freeUsed = Number(carry?.is_free) === 1 || freeReduction > 0;

    return [
      `${carryType} ${tier} x${amount}`,
      `Base: ${this.formatCoinsShort(baseTotal)}`,
      `Scope Discount: ${scopePct > 0 ? `${scopePct}% (${scopeScope})` : "None"}`,
      `Bulk Discount: ${bulkPct > 0 ? `${bulkPct}%` : "None"}`,
      `Free Carry Used: ${freeUsed ? `Yes (-${this.formatCoinsShort(freeReduction || 0)})` : "No"}`,
      `Final Price: ${this.formatCoinsShort(finalPrice)}`
    ].join(" | ");
  }

  async carrierComplete(carryId, carrierId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    this.db.getConnection().prepare("UPDATE carries SET carrier_confirmed = 1, customer_confirmed = 1 WHERE id = ?").run(carry.id);
    this.db.logEvent("carry.carrier_confirmed", "carry", carry.id, { carrierId });
    await this.finalizeCarry(carry.id);
    return { ok: true, finalized: true };
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
    await this.syncCarryTicketIndicators(carry.id);
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
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    await this.publishCarrierStatsDashboard().catch(() => {});
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

  async cancelCarry(carryId, actorId, options = {}) {
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

    await this.closeExecutionChannel(carry.execution_channel_id, { immediate: Boolean(options.immediateDelete) });
    this.db.logEvent("carry.cancelled", "carry", carry.id, { actorId });
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    return { ok: true };
  }

  async closeExecutionChannel(channelId, options = {}) {
    if (!channelId || !this.client) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    await channel.permissionOverwrites
      .edit(channel.guild.roles.everyone.id, {
        SendMessages: false
      })
      .catch(() => {});

    const delayMs = options.immediate ? 1000 : Math.max(10000, this.getCarryAutoDeleteMs());
    setTimeout(() => {
      channel.delete("Carry closed").catch(() => {});
    }, delayMs);
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

  async markPaid(carryId, actorId, amount = 0) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    const addAmount = Number(amount || 0);
    this.db
      .getConnection()
      .prepare("UPDATE carries SET is_paid = CASE WHEN ? > 0 THEN 1 ELSE is_paid END, paid_amount = COALESCE(paid_amount, 0) + ? WHERE id = ?")
      .run(addAmount, addAmount, carry.id);
    const priority = this.computePriorityScore({ isPaid: true, isFree: Number(carry.is_free) === 1, member: null });
    this.db.getConnection().prepare("UPDATE queue_entries SET priority_score = ? WHERE carry_id = ? AND state IN ('queued','claimed')").run(priority, carry.id);

    const refreshed = this.getCarryById(carry.id);
    const coverage = this.getPaymentCoverage(refreshed);
    this.db.logEvent("carry.mark_paid", "carry", carry.id, { actorId, amount: addAmount, coverage });
    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Payment logged on carry #${carry.id}: +${addAmount}. Total paid: ${coverage.paidAmount}. Covers ${coverage.coveredRuns}/${coverage.amount} runs. Remaining payment: ${coverage.remainingPayment}.`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
    }
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    await this.refreshExecutionPanel(carry.id).catch(() => {});
    return { ok: true, coverage };
  }

  getPaymentCoverage(carry) {
    const amount = Math.max(0, Number(carry?.amount || 0));
    const finalPrice = Math.max(0, Number(carry?.final_price || 0));
    const paidAmount = Math.max(0, Number(carry?.paid_amount || 0));
    const loggedRuns = Math.max(0, Number(carry?.logged_runs || 0));
    const unitPrice = amount > 0 ? finalPrice / amount : 0;
    const coveredRuns = unitPrice > 0 ? Math.floor(paidAmount / unitPrice) : amount;
    const remainingPayment = Math.max(0, Number((finalPrice - paidAmount).toFixed(2)));
    const uncoveredRuns = Math.max(0, amount - coveredRuns);
    const paidRunsRemaining = Math.max(0, coveredRuns - loggedRuns);
    return { amount, finalPrice, paidAmount, unitPrice, coveredRuns, loggedRuns, remainingPayment, uncoveredRuns, paidRunsRemaining };
  }

  async postLogRunsWarning(carry, actorId, addRuns, warnings) {
    if (!carry?.execution_channel_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.send({
      content: `<@${actorId}>`,
      embeds: [
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle(`Run Log Warning • Carry #${carry.id}`)
          .setDescription(warnings.join("\n"))
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}confirm_log_runs:${carry.id}:${addRuns}:${actorId}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}cancel_log_runs:${carry.id}:${actorId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}warn_add_paid:${carry.id}:${actorId}`).setLabel("Forgot Paid Amount").setStyle(ButtonStyle.Primary)
        )
      ]
    });
  }

  async postCustomerOverlogPrompt(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry?.execution_channel_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.send({
      content: carry.customer_discord_id ? `<@${carry.customer_discord_id}>` : undefined,
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle(`Over-Target Run Confirmation • Carry #${carry.id}`)
          .setDescription(`Carrier is trying to log beyond requested runs.\nPending add: **${carry.pending_log_runs}**\nCurrent: **${carry.logged_runs}/${carry.amount}**`)
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}customer_confirm_overlog:${carry.id}`).setLabel("Confirm Extra Runs").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${CARRY_PREFIX}customer_cancel_overlog:${carry.id}`).setLabel("Cancel").setStyle(ButtonStyle.Danger)
        )
      ]
    });
  }

  async applyLoggedRuns(carryId, actorId, addRuns) {
    const carry = this.getCarryById(carryId);
    const nextRuns = Number(carry.logged_runs || 0) + Number(addRuns || 0);
    const reached = nextRuns >= Number(carry.amount || 0);
    this.db
      .getConnection()
      .prepare("UPDATE carries SET logged_runs = ?, status = ?, started_at = COALESCE(started_at, ?), pending_log_runs = 0, pending_log_actor_id = NULL WHERE id = ?")
      .run(nextRuns, reached ? "pending_confirm" : "in_progress", Date.now(), carry.id);
    this.db.logEvent("carry.log_runs", "carry", carry.id, { actorId, runs: addRuns, total: nextRuns });
    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carrier logged runs for carry #${carry.id}: +${addRuns} (total ${nextRuns}/${carry.amount}).`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
    }
    if (reached) {
      await this.sendCustomerCompletionPrompt(carry.id);
    }
    await this.syncCarryTicketIndicators(carry.id);
    await this.refreshExecutionPanel(carry.id).catch(() => {});
    return { ok: true, reached, total: nextRuns };
  }

  async logRuns(carryId, actorId, runs, options = {}) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    const addRuns = Number(runs);
    if (!Number.isInteger(addRuns) || addRuns <= 0) return { ok: false, reason: "Runs must be a positive integer." };
    const coverage = this.getPaymentCoverage(carry);
    const nextRuns = Number(carry.logged_runs || 0) + addRuns;
    const unpaidOver = Math.max(0, nextRuns - coverage.coveredRuns);
    const targetOver = Math.max(0, nextRuns - Number(carry.amount || 0));

    if (!options.actorConfirmed && unpaidOver > 0) {
      const warnings = [
        `This log exceeds paid coverage by **${unpaidOver}** runs.`,
        `Paid covers: **${coverage.coveredRuns}/${coverage.amount}** runs`,
        `Remaining payment: **${coverage.remainingPayment}**`
      ];
      await this.postLogRunsWarning(carry, actorId, addRuns, warnings);
      return { ok: false, needsActorConfirm: true, reason: "Run log requires confirmation (unpaid overrun)." };
    }

    if (!options.customerConfirmed && targetOver > 0) {
      this.db.getConnection().prepare("UPDATE carries SET pending_log_runs = ?, pending_log_actor_id = ? WHERE id = ?").run(addRuns, String(actorId), carry.id);
      await this.postCustomerOverlogPrompt(carry.id);
      return { ok: false, needsCustomerConfirm: true, reason: "Over-target run log requires customer confirmation." };
    }

    return this.applyLoggedRuns(carryId, actorId, addRuns);
  }

  async sendCustomerCompletionPrompt(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry?.execution_channel_id || !this.client) return;
    if (carry.confirm_message_id) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const message = await channel
      .send({
        content: carry.customer_discord_id ? `<@${carry.customer_discord_id}>` : undefined,
        embeds: [new EmbedBuilder().setColor(0x3498db).setTitle(`Confirm Carry #${carry.id}`).setDescription("Carrier marked all runs complete. Confirm completion.")],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${CARRY_PREFIX}confirm_complete:${carry.id}`).setLabel("Confirm Complete").setStyle(ButtonStyle.Success))]
      })
      .catch(() => null);
    if (message) {
      this.db.getConnection().prepare("UPDATE carries SET confirm_message_id = ? WHERE id = ?").run(message.id, carry.id);
    }
  }

  async sendRatingPrompt(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry?.execution_channel_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const message = await channel
      .send({
        content: carry.customer_discord_id ? `<@${carry.customer_discord_id}> Please rate your carry experience.` : undefined,
        embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle(`Rate Carry #${carry.id}`).setDescription("Give a 1-5 rating for the carrier service.")],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${CARRY_PREFIX}rate:${carry.id}:1`).setLabel("1").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`${CARRY_PREFIX}rate:${carry.id}:2`).setLabel("2").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`${CARRY_PREFIX}rate:${carry.id}:3`).setLabel("3").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${CARRY_PREFIX}rate:${carry.id}:4`).setLabel("4").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${CARRY_PREFIX}rate:${carry.id}:5`).setLabel("5").setStyle(ButtonStyle.Success)
          )
        ]
      })
      .catch(() => null);
    if (message) {
      this.db.getConnection().prepare("UPDATE carries SET rating_message_id = ?, status = 'awaiting_rating' WHERE id = ?").run(message.id, carry.id);
    }
  }

  async confirmCarryCompletion(carryId, userId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (String(carry.customer_discord_id) !== String(userId)) return { ok: false, reason: "Only customer can confirm completion." };
    if (Number(carry.logged_runs || 0) < Number(carry.amount || 0)) return { ok: false, reason: "Carry runs are not fully logged yet." };

    this.db.getConnection().prepare("UPDATE carries SET customer_confirmed = 1 WHERE id = ?").run(carry.id);
    this.db.logEvent("carry.customer_confirmed", "carry", carry.id, { userId });
    await this.sendRatingPrompt(carry.id);
    await this.syncCarryTicketIndicators(carry.id);
    await this.refreshExecutionPanel(carry.id).catch(() => {});
    return { ok: true };
  }

  async closeCarryTicket(carryId, actorId, isStaffActor = false) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    const isCustomer = String(carry.customer_discord_id) === String(actorId);
    if (!isCustomer && !isStaffActor) return { ok: false, reason: "Only customer or staff can close this ticket." };

    if (Number(carry.logged_runs || 0) <= 0) {
      return this.cancelCarry(carryId, actorId, { immediateDelete: true });
    }

    return { ok: false, reason: "Runs are already logged. Confirm completion and submit rating to close." };
  }

  async repingCarriers(carryId, actorId, isStaffActor = false) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    const isCustomer = String(carry.customer_discord_id) === String(actorId);
    if (!isCustomer && !isStaffActor) return { ok: false, reason: "Only customer or staff can reping." };
    if (String(carry.status) !== "queued") return { ok: false, reason: "Reping is available only for unclaimed queued carries." };

    const now = Date.now();
    const ageMs = now - Number(carry.queued_at || carry.requested_at || now);
    if (ageMs < 6 * 60 * 60 * 1000) return { ok: false, reason: "Reping is available after 6 hours unclaimed." };
    if (carry.reping_last_at && now - Number(carry.reping_last_at) < 60 * 60 * 1000) return { ok: false, reason: "Reping cooldown active (1h)." };
    if (!this.hadCarrierOnlineBetween(Number(carry.queued_at || carry.requested_at || now), now)) {
      return { ok: false, reason: "No carriers were online during this unclaimed window." };
    }

    await this.ghostPingCarrierRole(carry.id);
    this.db.getConnection().prepare("UPDATE carries SET reping_last_at = ? WHERE id = ?").run(now, carry.id);
    this.db.logEvent("carry.reping", "carry", carry.id, { actorId });
    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carrier reping requested for carry #${carry.id} by <@${actorId}>.`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
    }
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
      const status = this.getFreeCarryStatus(userId);
      await interaction.reply({
        ephemeral: true,
        content: `Week: \`${status.weekKey}\`\nWeekly free carries: **${status.weeklyRemaining}/${status.limit}** remaining (${status.used} used).\nBonus credits: **${status.bonusRemaining}**\nTotal free carries available: **${status.totalRemaining}**`
      });
      return true;
    }

    if (parsed.action === "carrier_refresh") {
      await this.publishCarrierDashboard();
      await interaction.reply({ content: "Carrier dashboard refreshed.", ephemeral: true });
      return true;
    }

    if (parsed.action === "stats_refresh") {
      await this.publishCarrierStatsDashboard();
      await interaction.reply({ content: "Carrier stats refreshed.", ephemeral: true });
      return true;
    }

    if (parsed.action === "carrier_pick") {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can claim carries.", ephemeral: true });
        return true;
      }

      const selected = interaction.values?.[0];
      const carryId = Number(selected);
      if (!Number.isInteger(carryId) || carryId <= 0) {
        await interaction.reply({ content: "Invalid carry id selected.", ephemeral: true });
        return true;
      }

      const result = await this.claimCarry(carryId, interaction.user.id);
      await interaction.reply({ content: result.ok ? `Claimed carry #${carryId}.` : result.reason, ephemeral: true });
      return true;
    }

    if (parsed.action === "confirm_log_runs") {
      const [carryIdRaw, runsRaw, actorId] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      const runs = Number(runsRaw);
      if (!Number.isInteger(carryId) || !Number.isInteger(runs) || !actorId) {
        await interaction.reply({ content: "Invalid confirmation payload.", ephemeral: true });
        return true;
      }
      if (String(interaction.user.id) !== String(actorId) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only the requesting carrier can confirm this.", ephemeral: true });
        return true;
      }
      const result = await this.logRuns(carryId, actorId, runs, { actorConfirmed: true });
      await interaction.reply({ content: result.ok ? `Runs logged for carry #${carryId}.` : result.reason, ephemeral: true });
      return true;
    }

    if (parsed.action === "cancel_log_runs") {
      const [carryIdRaw, actorId] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      if (String(interaction.user.id) !== String(actorId) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only the requesting carrier can cancel this.", ephemeral: true });
        return true;
      }
      await interaction.reply({ content: `Run log canceled for carry #${carryId}.`, ephemeral: true });
      return true;
    }

    if (parsed.action === "warn_add_paid") {
      const [carryIdRaw, actorId] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      if (!Number.isInteger(carryId) || !actorId) {
        await interaction.reply({ content: "Invalid payload.", ephemeral: true });
        return true;
      }
      if (String(interaction.user.id) !== String(actorId) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only the requesting carrier can use this.", ephemeral: true });
        return true;
      }
      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}mark_paid:${carryId}`).setTitle("Log Payment");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("paid_amount").setLabel("Amount paid").setStyle(TextInputStyle.Short).setRequired(true))
      );
      await interaction.showModal(modal);
      return true;
    }

    if (["claim", "unclaim", "close_ticket", "reping"].includes(parsed.action) && parsed.carryId !== null) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        if (parsed.action === "close_ticket" || parsed.action === "reping") {
          // customer/staff path handled below
        } else {
          await interaction.editReply({ content: "Only carriers/staff can perform this action." });
          return true;
        }
      }

      let result = null;
      if (parsed.action === "claim") result = await this.claimCarry(parsed.carryId, interaction.user.id);
      if (parsed.action === "unclaim") result = await this.unclaimCarry(parsed.carryId, interaction.user.id, this.isStaff(interaction.member));
      if (parsed.action === "close_ticket") result = await this.closeCarryTicket(parsed.carryId, interaction.user.id, this.isStaff(interaction.member));
      if (parsed.action === "reping") result = await this.repingCarriers(parsed.carryId, interaction.user.id, this.isStaff(interaction.member));

      const doneText = parsed.action === "reping" ? `Reping sent for carry #${parsed.carryId}.` : `Action \`${parsed.action}\` applied on carry #${parsed.carryId}.`;
      await interaction.editReply({ content: result?.ok ? doneText : result?.reason || "Action failed." });
      return true;
    }

    if (["mark_paid", "log_runs"].includes(parsed.action) && parsed.carryId !== null) {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can perform this action.", ephemeral: true });
        return true;
      }

      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}${parsed.action}:${parsed.carryId}`).setTitle(parsed.action === "mark_paid" ? "Log Payment" : "Log Runs");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(parsed.action === "mark_paid" ? "paid_amount" : "runs")
            .setLabel(parsed.action === "mark_paid" ? "Amount paid" : "Runs completed")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
      await interaction.showModal(modal);
      return true;
    }

    if (parsed.action === "confirm_complete") {
      const result = await this.confirmCarryCompletion(parsed.carryId, interaction.user.id);
      await interaction.reply({ content: result.ok ? `Carry #${parsed.carryId} confirmed. Rating prompt posted.` : result.reason, ephemeral: true });
      return true;
    }

    if (parsed.action === "customer_confirm_overlog") {
      const carryId = Number(parsed.rawId);
      const carry = this.getCarryById(carryId);
      if (!carry) {
        await interaction.reply({ content: "Carry not found.", ephemeral: true });
        return true;
      }
      if (String(carry.customer_discord_id) !== String(interaction.user.id)) {
        await interaction.reply({ content: "Only customer can confirm over-target runs.", ephemeral: true });
        return true;
      }
      const pendingRuns = Number(carry.pending_log_runs || 0);
      const actorId = String(carry.pending_log_actor_id || "");
      if (!pendingRuns || !actorId) {
        await interaction.reply({ content: "No pending over-target run log.", ephemeral: true });
        return true;
      }
      const result = await this.logRuns(carryId, actorId, pendingRuns, { actorConfirmed: true, customerConfirmed: true });
      await interaction.reply({ content: result.ok ? `Over-target runs confirmed and logged for carry #${carryId}.` : result.reason, ephemeral: true });
      return true;
    }

    if (parsed.action === "customer_cancel_overlog") {
      const carryId = Number(parsed.rawId);
      const carry = this.getCarryById(carryId);
      if (!carry) {
        await interaction.reply({ content: "Carry not found.", ephemeral: true });
        return true;
      }
      if (String(carry.customer_discord_id) !== String(interaction.user.id) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only customer/staff can cancel this.", ephemeral: true });
        return true;
      }
      this.db.getConnection().prepare("UPDATE carries SET pending_log_runs = 0, pending_log_actor_id = NULL WHERE id = ?").run(carryId);
      await interaction.reply({ content: `Over-target run log canceled for carry #${carryId}.`, ephemeral: true });
      return true;
    }

    if (parsed.action === "rate") {
      const [carryIdRaw, ratingRaw] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      const rating = Number(ratingRaw);
      if (!Number.isInteger(carryId) || carryId <= 0 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        await interaction.reply({ content: "Invalid rating payload.", ephemeral: true });
        return true;
      }

      const carry = this.getCarryById(carryId);
      if (!carry) {
        await interaction.reply({ content: "Carry not found.", ephemeral: true });
        return true;
      }

      if (String(carry.customer_discord_id) !== String(interaction.user.id)) {
        await interaction.reply({ content: "Only the customer can rate this carry.", ephemeral: true });
        return true;
      }

      if (String(carry.status) !== "awaiting_rating") {
        await interaction.reply({ content: "Rating is not available yet for this carry.", ephemeral: true });
        return true;
      }

      const existing = this.db
        .getConnection()
        .prepare("SELECT id FROM customer_ratings WHERE carry_id = ? AND customer_discord_id = ?")
        .get(carryId, interaction.user.id);
      if (existing) {
        await interaction.reply({ content: "You already rated this carry.", ephemeral: true });
        return true;
      }

      this.db
        .getConnection()
        .prepare("INSERT INTO customer_ratings (carry_id, customer_discord_id, rating, comment, created_at) VALUES (?, ?, ?, NULL, ?)")
        .run(carryId, interaction.user.id, rating, Date.now());
      this.db.logEvent("carry.rated", "carry", carryId, { customerId: interaction.user.id, rating });
      await this.finalizeCarry(carryId);
      await this.publishCarrierStatsDashboard().catch(() => {});
      await interaction.reply({ content: `Thanks. You rated carry #${carryId} with ${rating}/5.`, ephemeral: true });
      return true;
    }

    if (["claim", "start", "complete", "cancel", "mark_paid", "log_runs"].includes(parsed.action) && parsed.carryId === null) {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can perform this action.", ephemeral: true });
        return true;
      }

      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}${parsed.action}`).setTitle(`${parsed.action} Carry`);
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("carry_id").setLabel("Carry ID").setStyle(TextInputStyle.Short).setRequired(true)));
      await interaction.showModal(modal);
      return true;
    }

    return false;
  }

  async handleModal(interaction) {
    if (!interaction.customId?.startsWith(CARRY_MODAL_PREFIX)) return false;

    const action = interaction.customId.slice(CARRY_MODAL_PREFIX.length);
    if (action.startsWith("mark_paid:")) {
      const carryId = Number(action.split(":")[1]);
      const amount = Number(interaction.fields.getTextInputValue("paid_amount"));
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const result = await this.markPaid(carryId, interaction.user.id, amount);
      await interaction.editReply({ content: result.ok ? `Logged payment for carry #${carryId}.` : result.reason });
      return true;
    }

    if (action.startsWith("log_runs:")) {
      const carryId = Number(action.split(":")[1]);
      const runs = Number(interaction.fields.getTextInputValue("runs"));
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const result = await this.logRuns(carryId, interaction.user.id, runs);
      await interaction.editReply({
        content: result.ok
          ? result.reached
            ? `Logged runs for carry #${carryId}. Target reached; customer confirmation requested.`
            : `Logged runs for carry #${carryId}.`
          : result.reason
      });
      return true;
    }

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
              { name: "Base Price", value: `${this.formatCoinsShort(breakdown.baseTotal)}`, inline: true },
              { name: "Discount", value: `${this.formatCoinsShort(created.totalDiscount)}`, inline: true },
              { name: "Final", value: `${this.formatCoinsShort(created.finalPrice)}`, inline: true },
              { name: "ETA", value: `~${mins} min`, inline: true },
              { name: "Free Carry", value: created.freeEligible ? `Applied (${created.freeSource || "weekly"})` : "Not available", inline: true }
            )
        ]
      });

      return true;
    }

    if (!["claim", "start", "complete", "cancel", "mark_paid", "log_runs"].includes(action)) {
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
    if (action === "mark_paid") result = await this.markPaid(carryId, interaction.user.id, 0);
    if (action === "log_runs") result = await this.logRuns(carryId, interaction.user.id, 1);

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
