const {
  ActionRowBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  ModalBuilder,
  OverwriteType,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { actionButton, makePanel, panelPayload, infoPayload } = require("./componentsV2Panels.js");
const { getDiscordIdByUuid } = require("../../contracts/linkedStore.js");
const DiscountEngine = require("./discountEngine.js");
const EtaEngine = require("./etaEngine.js");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const config = require("../../../config.json");

const CARRY_PREFIX = "carry:";
const CARRY_MODAL_PREFIX = "carrymodal:";
const CARRY_QUICK_PANEL_MAP_KEY = "carry_quick_panel_map_json";
const CARRY_ADMIN_SCOPE = "carry_admin_panel";
const SERVICE_ADMIN_FALLBACK_NAMES = ["service-admin", "service admin", "serviceadmin"];
const SERVICE_TEAM_FALLBACK_NAMES = ["service-team", "service team", "serviceteam"];
const SCORE_WEIGHTS = Object.freeze({
  dungeons: { f1: 1, f2: 2, f3: 3, f4: 5, f5: 7, f6: 10, f7: 15, m1: 18, m2: 22, m3: 26, m4: 32, m5: 40, m6: 55, m7: 75 },
  kuudra: { basic: 15, hot: 22, burning: 35, fiery: 50, infernal: 75 },
  slayer_zombie: { 1: 1, 2: 2, 3: 3, 4: 5, 5: 7, t1: 1, t2: 2, t3: 3, t4: 5, t5: 7 },
  slayer_tara: { 1: 1, 2: 2, 3: 4, 4: 6, 5: 10, t1: 1, t2: 2, t3: 4, t4: 6, t5: 10 },
  slayer_sven: { 1: 1, 2: 2, 3: 4, 4: 6, t1: 1, t2: 2, t3: 4, t4: 6 },
  slayer_eman: { 1: 2, 2: 4, 3: 7, 4: 12, t1: 2, t2: 4, t3: 7, t4: 12 },
  slayer_blaze: { 1: 3, 2: 6, 3: 10, 4: 20, t1: 3, t2: 6, t3: 10, t4: 20 }
});

class CarryService {
  constructor(db, ticketService) {
    this.db = db;
    this.ticketService = ticketService;
    this.client = null;
    this.discountEngine = new DiscountEngine(db);
    this.etaEngine = new EtaEngine(db);
    this.reassignmentInterval = null;
    this.watchdogRunning = false;
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
      if (this.watchdogRunning) return;
      this.watchdogRunning = true;
      (async () => {
        await this.checkStaleQueueEntries().catch(() => {});
        await this.reconcileMissingCarryArtifacts().catch(() => {});
        await this.sampleCarrierOnlineCount().catch(() => {});
        await this.autoCloseInactiveCarries().catch(() => {});
      })()
        .catch(() => {})
        .finally(() => {
          this.watchdogRunning = false;
        });
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
        const pseudoUser = carry.customer_discord_id ? { id: String(carry.customer_discord_id), username: "customer", tag: "customer" } : null;
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
          this.db.getConnection().prepare("UPDATE carries SET execution_channel_id = ? WHERE id = ?").run(created.channel.id, carry.id);
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
      ["kuudra", "basic", "kuudra", 6000000],
      ["kuudra", "hot", "kuudra", 10000000],
      ["kuudra", "burning", "kuudra", 15000000],
      ["kuudra", "fiery", "kuudra", 20000000],
      ["kuudra", "infernal", "kuudra", 45000000]
    ];

    const insert = db.prepare("INSERT INTO carry_catalog (carry_type, tier, category, price, enabled) VALUES (?, ?, ?, 0, 1) ON CONFLICT(carry_type, tier) DO NOTHING");
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
    // Hard-disable legacy blaze tier 5 if it exists from older data.
    db.prepare("UPDATE carry_catalog SET enabled = 0 WHERE lower(carry_type)=lower('slayer_blaze') AND lower(tier) IN ('5','t5')").run();
  }

  getCarrierRoleIds() {
    const bound = this.db.getBinding("carrier_claim_role_id", null);
    const configured = (config.discord?.carry?.carrierRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id))).map((id) => String(id));
    if (!bound || !/^\d{17,20}$/.test(String(bound))) {
      return configured;
    }

    const merged = new Set(configured);
    merged.add(String(bound));
    return [...merged];
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

  setServiceAdminRoleId(roleId) {
    if (!roleId) {
      this.db.setBinding("service_admin_role_id", null);
      return;
    }
    this.db.setBinding("service_admin_role_id", String(roleId));
  }

  getServiceAdminRoleId() {
    const bound = this.db.getBinding("service_admin_role_id", null);
    return bound && /^\d{17,20}$/.test(String(bound)) ? String(bound) : null;
  }

  setServiceTeamRoleId(roleId) {
    if (!roleId) {
      this.db.setBinding("service_team_role_id", null);
      return;
    }
    this.db.setBinding("service_team_role_id", String(roleId));
  }

  getServiceTeamRoleId() {
    const bound = this.db.getBinding("service_team_role_id", null);
    return bound && /^\d{17,20}$/.test(String(bound)) ? String(bound) : null;
  }

  getStaffRoleIds() {
    const configured = (config.discord?.tickets?.staffRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id)));
    if (configured.length) return configured;
    const fallback = config.discord?.commands?.commandRole;
    return /^\d{17,20}$/.test(String(fallback || "")) ? [String(fallback)] : [];
  }

  getAdminRoleIds(guild = null) {
    const configured = (config.discord?.carry?.serviceAdminRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id))).map((id) => String(id));
    const bound = this.db.getBinding("service_admin_role_id", null);
    const fromBinding = /^\d{17,20}$/.test(String(bound || "")) ? [String(bound)] : [];
    const fromLegacyStaff = this.getStaffRoleIds();
    const merged = new Set([...configured, ...fromBinding, ...fromLegacyStaff]);
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

  getTeamRoleIds(guild = null) {
    const configured = (config.discord?.carry?.serviceTeamRoleIds || []).filter((id) => /^\d{17,20}$/.test(String(id))).map((id) => String(id));
    const bound = this.db.getBinding("service_team_role_id", null);
    const fromBinding = /^\d{17,20}$/.test(String(bound || "")) ? [String(bound)] : [];
    const merged = new Set([...configured, ...fromBinding]);
    if (merged.size > 0 || !guild?.roles?.cache) return [...merged];
    for (const role of guild.roles.cache.values()) {
      const normalized = String(role.name || "")
        .toLowerCase()
        .replace(/[\s_-]+/g, " ")
        .trim();
      if (SERVICE_TEAM_FALLBACK_NAMES.includes(normalized)) merged.add(String(role.id));
    }
    return [...merged];
  }

  getMemberRoleIds(member) {
    if (!member) return [];
    if (member.roles?.cache && typeof member.roles.cache.map === "function") {
      return member.roles.cache.map((role) => String(role.id));
    }
    if (Array.isArray(member.roles)) {
      return member.roles.map((id) => String(id));
    }
    if (Array.isArray(member._roles)) {
      return member._roles.map((id) => String(id));
    }
    return [];
  }

  isStaff(member) {
    if (this.isAdmin(member) || this.isTeam(member)) return true;
    const configured = this.getStaffRoleIds();
    const fallback = config.discord?.commands?.commandRole;
    const roleIds = this.getMemberRoleIds(member);
    if (!roleIds.length) return false;
    if (configured.length > 0) {
      return roleIds.some((id) => configured.includes(id));
    }
    return fallback ? roleIds.includes(String(fallback)) : false;
  }

  isAdmin(member) {
    if (!member) return false;
    const roleIds = this.getMemberRoleIds(member);
    if (!roleIds.length) return false;
    const adminRoleIds = this.getAdminRoleIds(member.guild || null);
    if (adminRoleIds.length > 0 && roleIds.some((id) => adminRoleIds.includes(id))) return true;
    if (member.roles?.cache && typeof member.roles.cache.some === "function") {
      return member.roles.cache.some((role) => {
        const normalized = String(role?.name || "")
          .toLowerCase()
          .replace(/[\s_-]+/g, " ")
          .trim();
        return SERVICE_ADMIN_FALLBACK_NAMES.includes(normalized);
      });
    }
    return false;
  }

  isTeam(member) {
    if (!member) return false;
    const roleIds = this.getMemberRoleIds(member);
    if (!roleIds.length) return false;
    const teamRoleIds = this.getTeamRoleIds(member.guild || null);
    if (teamRoleIds.length > 0 && roleIds.some((id) => teamRoleIds.includes(id))) return true;
    if (member.roles?.cache && typeof member.roles.cache.some === "function") {
      return member.roles.cache.some((role) => {
        const normalized = String(role?.name || "")
          .toLowerCase()
          .replace(/[\s_-]+/g, " ")
          .trim();
        return SERVICE_TEAM_FALLBACK_NAMES.includes(normalized);
      });
    }
    return false;
  }

  isCarrier(member) {
    const carrierRoles = this.getCarrierRoleIds();
    const roleIds = this.getMemberRoleIds(member);
    if (!roleIds.length) return false;
    if (carrierRoles.length === 0) {
      return this.isStaff(member);
    }

    return roleIds.some((id) => carrierRoles.includes(id)) || this.isStaff(member);
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
    return Number(this.db.getBinding("carry_autodelete_ms", 60 * 1000));
  }

  async reopenCarryForTicket(ticketId, actorId = null) {
    const carry = this.db.getConnection().prepare("SELECT * FROM carries WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(Number(ticketId));

    if (!carry) return { ok: true, message: "Ticket reopened (no carry linked)." };
    if (String(carry.status) === "completed") {
      return { ok: false, reason: "Completed carry cannot be reopened." };
    }

    let nextStatus = String(carry.status || "queued");
    if (nextStatus === "cancelled" && Number(carry.logged_runs || 0) <= 0) {
      nextStatus = "queued";
      this.db.getConnection().prepare("UPDATE carries SET status = 'queued', cancelled_at = NULL WHERE id = ?").run(carry.id);
      const exists = this.db.getConnection().prepare("SELECT id FROM queue_entries WHERE carry_id = ?").get(carry.id);
      const priority = this.computePriorityScore({ isPaid: Number(carry.is_paid) === 1, isFree: Number(carry.is_free) === 1, member: null });
      if (exists?.id) {
        this.db.getConnection().prepare("UPDATE queue_entries SET state = 'queued', priority_score = ?, stale_notified = 0 WHERE carry_id = ?").run(priority, carry.id);
      } else {
        this.db
          .getConnection()
          .prepare("INSERT INTO queue_entries (carry_id, state, priority_score, created_at, stale_notified) VALUES (?, 'queued', ?, ?, 0)")
          .run(carry.id, priority, Date.now());
      }
      this.db.logEvent("carry.reopened", "carry", carry.id, { actorId: actorId || null });
    }

    const current = this.getCarryById(carry.id);
    const existingChannel = current?.execution_channel_id ? await this.client?.channels?.fetch(current.execution_channel_id).catch(() => null) : null;
    if (!existingChannel) {
      if (current?.execution_channel_id) {
        this.db.getConnection().prepare("UPDATE carries SET execution_channel_id = NULL, execution_message_id = NULL WHERE id = ?").run(carry.id);
      }
      const assigned = JSON.parse(current?.assigned_carrier_discord_ids || "[]");
      const created = await this.createExecutionChannel({ carry: this.getCarryById(carry.id), carrierIds: assigned });
      if (created?.ok && created.channel?.id) {
        this.db.getConnection().prepare("UPDATE carries SET execution_channel_id = ? WHERE id = ?").run(created.channel.id, carry.id);
      } else if (nextStatus !== "completed") {
        return { ok: false, reason: created?.reason || "Failed to recreate carry channel." };
      }
    }

    await this.publishCarrierDashboard().catch(() => {});
    await this.refreshExecutionPanel(carry.id).catch(() => {});
    await this.syncCarryTicketIndicators(carry.id).catch(() => {});
    return { ok: true, message: `Carry #${carry.id} reopened.` };
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
    const typePart = this.sanitizeNamePart(type || "carry", "carry");
    const amountPart = this.sanitizeNamePart(amount || "-", "-");
    const namePart = this.sanitizeNamePart(name || "customer", "customer");
    return `├🎟️》${typePart}-${amountPart}-${namePart}`.slice(0, 100);
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

  parseCoinsInput(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : NaN;
    }

    const raw = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/,/g, ".");
    if (!raw) return NaN;
    const match = raw.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
    if (!match) return NaN;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return NaN;
    const suffix = match[2] || "";
    const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
    return base * mult;
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

  isExcludedFromFreeCarry(carryType, tier) {
    const type = String(carryType || "")
      .toLowerCase()
      .trim();
    const normalizedTier = String(tier || "")
      .toLowerCase()
      .trim();
    if (type === "kuudra") return true;
    if (type === "dungeons" && normalizedTier === "m7") return true;
    return false;
  }

  isVerifiedForFreeCarry(member, userId = null) {
    if (userId && config.discord?.commands?.users?.includes(String(userId))) return true;
    if (config.verification?.enabled === false) return true;
    const verifiedRoleId = String(config.verification?.roles?.verified?.roleId || "").trim();
    if (!verifiedRoleId) return false;
    const roleIds = this.getMemberRoleIds(member);
    return roleIds.includes(verifiedRoleId);
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
    this.db
      .getConnection()
      .prepare("INSERT INTO role_priorities (role_id, value) VALUES (?, ?) ON CONFLICT(role_id) DO UPDATE SET value = excluded.value")
      .run(roleId, Number(value));
  }

  getRolePriorityScore(member) {
    if (!member?.roles?.cache) return 0;
    const roleIds = member.roles.cache.map((role) => role.id);
    if (roleIds.length === 0) return 0;
    const placeholders = roleIds.map(() => "?").join(",");
    const rows = this.db
      .getConnection()
      .prepare(`SELECT value FROM role_priorities WHERE role_id IN (${placeholders})`)
      .all(...roleIds);
    if (!rows.length) return 0;
    return Math.max(...rows.map((row) => Number(row.value || 0)));
  }

  getCatalogItem(type, tier) {
    return this.db.getConnection().prepare("SELECT * FROM carry_catalog WHERE lower(carry_type) = lower(?) AND lower(tier) = lower(?)").get(String(type), String(tier));
  }

  isDisallowedCarryTier(type, tier) {
    const normalizedType = String(type || "").toLowerCase();
    const normalizedTier = String(tier || "").toLowerCase();
    return normalizedType === "slayer_blaze" && (normalizedTier === "5" || normalizedTier === "t5");
  }

  getScoreWeight(carryType, tier) {
    const normalizedType = String(carryType || "").toLowerCase();
    const normalizedTier = String(tier || "").toLowerCase();
    const byType = SCORE_WEIGHTS[normalizedType];
    if (!byType) return 1;
    return Number(byType[normalizedTier] || 1);
  }

  addCarryTypeWithTiers(name, tiersText) {
    const tiers = String(tiersText)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const db = this.db.getConnection();
    const stmt = db.prepare("INSERT INTO carry_catalog (carry_type, tier, category, price, enabled) VALUES (?, ?, ?, 0, 1) ON CONFLICT(carry_type, tier) DO NOTHING");
    const normalizedName = String(name || "").toLowerCase();
    const tx = db.transaction(() => {
      for (const tier of tiers) {
        const normalizedTier = String(tier || "").toLowerCase();
        if (this.isDisallowedCarryTier(normalizedName, normalizedTier)) continue;
        stmt.run(normalizedName, normalizedTier, this.inferCategory(name));
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
    if (this.isDisallowedCarryTier(type, tier)) return 0;
    return this.db
      .getConnection()
      .prepare("UPDATE carry_catalog SET price = ? WHERE lower(carry_type) = lower(?) AND lower(tier) = lower(?)")
      .run(Number(price), type, tier).changes;
  }

  setCarryEnabled(type, enabled) {
    if (!enabled) {
      return this.db.getConnection().prepare("UPDATE carry_catalog SET enabled = 0 WHERE lower(carry_type) = lower(?)").run(type).changes;
    }

    return this.db.getConnection().prepare("UPDATE carry_catalog SET enabled = 1 WHERE lower(carry_type) = lower(?) AND lower(tier) NOT IN ('5','t5')").run(type).changes;
  }

  getQueueRows() {
    return this.db
      .getConnection()
      .prepare(
        `SELECT q.*, c.carry_type, c.tier, c.amount, c.customer_discord_id, c.final_price, c.is_paid, c.is_free, c.status
         FROM queue_entries q
         JOIN carries c ON c.id = q.carry_id
         WHERE q.state = 'queued'
         ORDER BY q.priority_score DESC, q.created_at ASC`
      )
      .all();
  }

  getEnabledCatalog() {
    return this.db
      .getConnection()
      .prepare(
        "SELECT carry_type, tier, category, price FROM carry_catalog WHERE enabled = 1 AND NOT (lower(carry_type)=lower('slayer_blaze') AND lower(tier) IN ('5','t5')) ORDER BY category ASC, carry_type ASC, tier ASC"
      )
      .all();
  }

  getActiveCarrierStats() {
    const row = this.db
      .getConnection()
      .prepare("SELECT COUNT(*) AS active FROM carrier_stats WHERE updated_at >= ?")
      .get(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return Number(row?.active || 0);
  }

  getPanelState(panelScope, messageId, actorId) {
    return this.db.getUiPanelState({
      panelScope,
      messageId,
      actorId,
      fallback: { viewKey: "overview", page: 1, expanded: [] }
    });
  }

  setPanelState(panelScope, messageId, actorId, next) {
    this.db.setUiPanelState({
      panelScope,
      messageId,
      actorId,
      viewKey: next?.viewKey || "overview",
      page: Math.max(1, Number(next?.page || 1)),
      expanded: Array.isArray(next?.expanded) ? next.expanded : []
    });
  }

  getCarryAdminState(messageId, actorId) {
    const raw = this.db.getUiPanelState({
      panelScope: CARRY_ADMIN_SCOPE,
      messageId: String(messageId || "0"),
      actorId: String(actorId || "0"),
      fallback: { viewKey: "", page: 1, expanded: [] }
    });
    const targetCarryId = /^\d+$/.test(String(raw?.viewKey || "")) ? Number(raw.viewKey) : null;
    return { targetCarryId };
  }

  setCarryAdminState(messageId, actorId, targetCarryId) {
    this.db.setUiPanelState({
      panelScope: CARRY_ADMIN_SCOPE,
      messageId: String(messageId || "0"),
      actorId: String(actorId || "0"),
      viewKey: targetCarryId ? String(targetCarryId) : "",
      page: 1,
      expanded: []
    });
  }

  getAdminCarryRows(limit = 25) {
    return this.db
      .getConnection()
      .prepare(
        `SELECT id, status, carry_type, tier, amount, customer_discord_id, assigned_carrier_discord_ids, paid_amount, final_price, logged_runs
         FROM carries
         WHERE status IN ('queued','claimed','in_progress','pending_confirm','awaiting_rating')
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(Math.max(1, Number(limit || 25)));
  }

  buildCarryAdminPanel({ messageId, actorId }) {
    const rows = this.getAdminCarryRows(25);
    const state = this.getCarryAdminState(messageId, actorId);
    const fallbackId = rows.length > 0 ? Number(rows[0].id) : null;
    const targetCarryId = rows.some((row) => Number(row.id) === Number(state.targetCarryId)) ? Number(state.targetCarryId) : fallbackId;
    if (targetCarryId) this.setCarryAdminState(messageId, actorId, targetCarryId);
    const target = rows.find((row) => Number(row.id) === Number(targetCarryId)) || null;

    let assignedCarrierIds = [];
    if (target) {
      try {
        const parsed = JSON.parse(target.assigned_carrier_discord_ids || "[]");
        assignedCarrierIds = Array.isArray(parsed) ? parsed : [];
      } catch {
        assignedCarrierIds = [];
      }
    }

    const summaryLines = target
      ? [
          `- Carry: **#${target.id}** (${target.status})`,
          `- Type: **${target.carry_type} ${target.tier} x${target.amount}**`,
          `- Customer: ${target.customer_discord_id ? `<@${target.customer_discord_id}>` : "Unknown"}`,
          `- Carriers: ${assignedCarrierIds.length ? assignedCarrierIds.map((id) => `<@${id}>`).join(", ") : "none"}`,
          `- Paid/Total: **${this.formatCoinsShort(target.paid_amount || 0)} / ${this.formatCoinsShort(target.final_price || 0)}**`,
          `- Runs: **${Number(target.logged_runs || 0)}/${Number(target.amount || 0)}**`
        ]
      : ["No active carries available."];

    const panel = makePanel({
      title: "Carry Admin Panel",
      status: target ? `Target #${target.id}` : "No active target",
      sections: [
        {
          title: "Controls",
          lines: ["- Force actions are admin-only.", "- Team members should use normal carry buttons in their claimed ticket channels."]
        },
        {
          title: "Target",
          lines: summaryLines
        }
      ],
      actions: [
        actionButton(`${CARRY_PREFIX}admin_refresh`, "Refresh", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}admin_force_unclaim`, "Force Unclaim", ButtonStyle.Danger, { disabled: !target }),
        actionButton(`${CARRY_PREFIX}admin_force_reassign`, "Force Reassign", ButtonStyle.Primary, { disabled: !target }),
        actionButton(`${CARRY_PREFIX}admin_view_logs`, "View Logs", ButtonStyle.Secondary, { disabled: !target })
      ],
      accentColor: 0xed4245
    });

    const options = rows.slice(0, 25).map((row) => ({
      label: `#${row.id} ${row.carry_type} ${row.tier} x${row.amount}`.slice(0, 100),
      description: `${String(row.status)} | paid ${this.formatCoinsShort(row.paid_amount || 0)}/${this.formatCoinsShort(row.final_price || 0)}`.slice(0, 100),
      value: String(row.id),
      default: Number(row.id) === Number(targetCarryId)
    }));

    const picker = new StringSelectMenuBuilder()
      .setCustomId(`${CARRY_PREFIX}admin_target`)
      .setPlaceholder(rows.length > 0 ? "Select carry target" : "No active carries")
      .addOptions(options.length > 0 ? options : [{ label: "No active carries", description: "Queue is currently empty.", value: "none" }]);
    if (rows.length === 0) picker.setDisabled(true);

    panel.addActionRowComponents(new ActionRowBuilder().addComponents(picker));
    return panelPayload(panel, { ephemeral: true });
  }

  paginateRows(rows, page = 1, pageSize = 10) {
    const cleanPage = Math.max(1, Number(page || 1));
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const boundedPage = Math.min(cleanPage, totalPages);
    const start = (boundedPage - 1) * pageSize;
    return {
      items: rows.slice(start, start + pageSize),
      page: boundedPage,
      totalPages
    };
  }

  buildCarryDashboardPanel({ viewKey = "overview", page = 1 }) {
    const queueRows = this.getQueueRows();
    const catalog = this.getEnabledCatalog();
    const byCategory = new Map();
    for (const item of catalog) {
      const key = String(item.category || "other");
      const list = byCategory.get(key) || [];
      list.push(item);
      byCategory.set(key, list);
    }

    const panelSections = [];
    const actions = [];

    if (viewKey === "queue") {
      const paged = this.paginateRows(queueRows, page, 10);
      const lines = paged.items.length
        ? paged.items.map((row) => {
            const paidFlag = Number(row.is_paid) ? "PAID" : Number(row.is_free) ? "FREE" : "STD";
            return `- #${row.carry_id} [${paidFlag}] ${row.carry_type} ${row.tier} x${row.amount} | <@${row.customer_discord_id}>`;
          })
        : ["No queued carries."];
      panelSections.push({ title: "Queue", lines });
      panelSections.push({
        title: "Summary",
        lines: [`Queue Size: **${queueRows.length}**`, `Active Carriers (7d): **${this.getActiveCarrierStats()}**`]
      });
    } else if (viewKey === "stats") {
      const statsRows = this.db
        .getConnection()
        .prepare(
          `SELECT user_id, completed_tickets_count, actual_carries_count, score_total
           FROM carrier_stats
           ORDER BY score_total DESC, completed_tickets_count DESC, updated_at DESC`
        )
        .all();
      const paged = this.paginateRows(statsRows, page, 10);
      const lines = paged.items.length
        ? paged.items.map(
            (row, i) =>
              `- ${i + 1 + (paged.page - 1) * 10}. <@${row.user_id}> | tickets: **${Number(row.completed_tickets_count || 0)}** | carries: **${Number(row.actual_carries_count || 0)}** | score: **${Math.round(Number(row.score_total || 0))}**`
          )
        : ["No carrier stats yet."];
      panelSections.push({ title: "Carrier Stats", lines });
    } else if (viewKey === "logs") {
      const eventRows = this.db
        .getConnection()
        .prepare("SELECT event_type, entity_id, created_at FROM events WHERE entity_type IN ('carry','ticket') ORDER BY id DESC LIMIT 200")
        .all();
      const paged = this.paginateRows(eventRows, page, 10);
      const lines = paged.items.length
        ? paged.items.map((row) => `- ${row.event_type} (#${row.entity_id}) at <t:${Math.floor(Number(row.created_at || Date.now()) / 1000)}:R>`)
        : ["No logs yet."];
      panelSections.push({ title: "Recent Logs", lines });
    } else {
      panelSections.push({
        title: "Overview",
        lines: [
          "Select a carry from the dropdown, then enter amount.",
          "Free carry is available only for verified users (default: 1/week UTC) and is excluded",
          "for Kuudra and Dungeons M7.",
          "Use **Check Free Carry** to view your status."
        ]
      });
      actions.push(actionButton(`${CARRY_PREFIX}check_free`, "Check Free Carry", ButtonStyle.Secondary));
    }

    const panel = makePanel({
      title: "Carry Request Dashboard",
      status: viewKey === "overview" ? null : viewKey,
      sections: panelSections,
      actions,
      accentColor: 0x5865f2
    });

    if (viewKey === "overview") {
      for (const [category, items] of byCategory.entries()) {
        const options = items.slice(0, 25).map((item) => ({
          label: `${item.carry_type} ${item.tier}`.slice(0, 100),
          description: `Price: ${this.formatCoinsShort(item.price)} each`.slice(0, 100),
          value: `${item.carry_type}|${item.tier}`.slice(0, 100)
        }));
        if (options.length === 0) continue;
        panel.addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${CARRY_PREFIX}select:${category}`).setPlaceholder(`Select ${category} carry`).addOptions(options)
          )
        );
      }
    }

    return panelPayload(panel);
  }

  async publishCarryDashboard(channelId = null, options = {}) {
    const targetId = channelId || this.getCarryDashboardChannelId();
    if (!targetId || !this.client) return null;

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;

    this.setCarryDashboardChannelId(channel.id);

    const messageId = this.db.getBinding("carry_dashboard_message_id", null);
    let message = null;
    if (messageId) message = await channel.messages.fetch(messageId).catch(() => null);

    const viewKey = String(options.viewKey || "overview");
    const page = Math.max(1, Number(options.page || 1));
    const payload = this.buildCarryDashboardPanel({ viewKey, page });

    if (message && typeof message.edit === "function") {
      await message.edit(payload).catch(() => {});
      return message;
    }

    message = await channel.send(payload);
    this.db.setBinding("carry_dashboard_message_id", message.id);
    return message;
  }

  async publishCarrierDashboard(channelId = null, options = {}) {
    const targetId = channelId || this.getCarrierDashboardChannelId();
    if (!targetId || !this.client) return null;

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;

    this.setCarrierDashboardChannelId(channel.id);

    const rows = this.getQueueRows();
    const paged = this.paginateRows(rows, Number(options?.page || 1), 10);
    const queueLines = paged.items.length
      ? paged.items.map((row) => {
          const paidFlag = Number(row.is_paid) ? "PAID" : Number(row.is_free) ? "FREE" : "STD";
          return `- #${row.carry_id} [${paidFlag}] ${row.carry_type} ${row.tier} x${row.amount} | <@${row.customer_discord_id}>`;
        })
      : ["Queue is empty."];

    const panel = makePanel({
      title: "Carrier Dashboard",
      status: paged.totalPages > 1 ? `page ${paged.page}/${paged.totalPages}` : null,
      topRows: [
        new ActionRowBuilder().addComponents(
          actionButton(`${CARRY_PREFIX}claim`, "Claim by ID", ButtonStyle.Success),
          actionButton(`${CARRY_PREFIX}carrier_refresh`, "Refresh", ButtonStyle.Secondary)
        )
      ],
      sections: [
        { title: "Queue", lines: queueLines },
        {
          title: "Live Metrics",
          lines: [
            `Queue Size: **${rows.length}**`,
            `Active Carries: **${rows.filter((r) => ["queued", "claimed", "in_progress", "pending_confirm"].includes(String(r.status))).length}**`
          ]
        }
      ],
      actions: [
        actionButton(`${CARRY_PREFIX}bulk:claim_next_3`, "Claim Next 3", ButtonStyle.Primary),
        actionButton(`${CARRY_PREFIX}bulk:close_completed`, "Close Completed", ButtonStyle.Danger)
      ],
      nav:
        paged.totalPages > 1
          ? [
              actionButton(`${CARRY_PREFIX}page:carrier_dashboard:${Math.max(1, paged.page - 1)}`, "Prev", ButtonStyle.Secondary),
              actionButton(`${CARRY_PREFIX}jump:carrier_dashboard`, "Jump", ButtonStyle.Primary),
              actionButton(`${CARRY_PREFIX}page:carrier_dashboard:${paged.page + 1}`, "Next", ButtonStyle.Secondary)
            ]
          : [],
      accentColor: 0x2ecc71,
      footer: "Quick claim via dropdown, or use Claim by ID."
    });

    const container = new ContainerBuilder(panel.toJSON());
    const selectOptions =
      paged.items.length > 0
        ? paged.items.slice(0, 25).map((row) => ({
            label: `#${row.carry_id} ${row.carry_type} ${row.tier} x${row.amount}`.slice(0, 100),
            description: `prio ${Math.round(Number(row.priority_score || 0))}`.slice(0, 100),
            value: String(row.carry_id)
          }))
        : [{ label: "No queued carries", description: "Queue is currently empty.", value: "none" }];
    const picker = new StringSelectMenuBuilder()
      .setCustomId(`${CARRY_PREFIX}carrier_pick`)
      .setPlaceholder(paged.items.length > 0 ? "Choose a carry to claim" : "Queue is empty")
      .addOptions(selectOptions);
    if (paged.items.length === 0) picker.setDisabled(true);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(picker));
    const payload = panelPayload(container);

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

  async publishCarrierStatsDashboard(channelId = null, options = {}) {
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
                cs.completed_tickets_count,
                cs.actual_carries_count,
                cs.score_total,
                cs.total_duration_ms,
                cs.acceptance_rate,
                COALESCE((SELECT ROUND(AVG(r.rating), 2) FROM customer_ratings r
                         JOIN carries c ON c.id = r.carry_id
                         WHERE c.assigned_carrier_discord_ids LIKE '%' || cs.user_id || '%'), 0) AS avg_rating
         FROM carrier_stats cs
         ORDER BY cs.score_total DESC, cs.completed_tickets_count DESC, cs.updated_at DESC
         LIMIT 15`
      )
      .all();

    const paged = this.paginateRows(rows, Number(options.page || 1), 10);
    const lines =
      paged.items.length === 0
        ? ["No carrier stats yet."]
        : paged.items.map((row, i) => {
            const avgMinutes = row.completed_count > 0 ? Math.round(Number(row.total_duration_ms || 0) / Number(row.completed_count) / 60000) : 0;
            const acceptance = Math.round(Number(row.acceptance_rate || 0) * 100);
            const rating = Number(row.avg_rating || 0);
            const tickets = Number(row.completed_tickets_count || row.completed_count || 0);
            const actualCarrys = Number(row.actual_carries_count || 0);
            const score = Number(row.score_total || 0);
            return `- ${i + 1 + (paged.page - 1) * 10}. <@${row.user_id}> | tickets: **${tickets}** | carries: **${actualCarrys}** | score: **${Math.round(score)}** | avg: **${avgMinutes}m** | accept: **${acceptance}%** | rating: **${rating || "-"}**`;
          });

    const payload = panelPayload(
      makePanel({
        title: "Carrier Stats",
        status: paged.totalPages > 1 ? `page ${paged.page}/${paged.totalPages}` : null,
        sections: [{ title: "Leaderboard", lines }],
        actions: [actionButton(`${CARRY_PREFIX}stats_refresh`, "Refresh", ButtonStyle.Secondary)],
        nav:
          paged.totalPages > 1
            ? [
                actionButton(`${CARRY_PREFIX}page:stats_dashboard:${Math.max(1, paged.page - 1)}`, "Prev", ButtonStyle.Secondary),
                actionButton(`${CARRY_PREFIX}jump:stats_dashboard`, "Jump", ButtonStyle.Primary),
                actionButton(`${CARRY_PREFIX}page:stats_dashboard:${paged.page + 1}`, "Next", ButtonStyle.Secondary)
              ]
            : [],
        accentColor: 0xf1c40f
      })
    );

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

    const discordId = getDiscordIdByUuid(uuid);
    if (!discordId) return null;
    return { uuid, discordId };
  }

  createCarryRequest({ guildId, customerUser, member, carryType, tier, amount, isPaid = false, source = "discord" }) {
    if (!this.isQueueEnabled()) {
      return { ok: false, reason: "Carry queue is currently disabled." };
    }

    const normalizedType = String(carryType || "")
      .toLowerCase()
      .trim();
    const normalizedTier = String(tier || "")
      .toLowerCase()
      .trim();
    const qty = Number(amount);

    if (!normalizedType || !normalizedTier || !Number.isInteger(qty) || qty <= 0) {
      return { ok: false, reason: "Invalid carry request payload." };
    }
    if (this.isDisallowedCarryTier(normalizedType, normalizedTier)) {
      return { ok: false, reason: "Blaze tier 5 is currently not available." };
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
    const freeBlockedByType = this.isExcludedFromFreeCarry(normalizedType, normalizedTier);
    const freeBlockedByVerification = !this.isVerifiedForFreeCarry(member, customerUser?.id || null);
    const freeEligible = !isPaid && !!freeStatus?.eligible && !freeBlockedByType && !freeBlockedByVerification;
    const freeReduction = freeEligible ? Number(catalog.price) : 0;
    const selectedFreeSource = freeEligible ? freeStatus?.source || "weekly" : null;

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
          .run(
            String(guildId || ""),
            `Carry Request - ${normalizedType} ${normalizedTier}`,
            customerUser.id,
            customerUser.tag || customerUser.username,
            now,
            customerUser.id
          );
        ticketId = Number(temp.lastInsertRowid);
      }

      const carryInsert = this.db
        .getConnection()
        .prepare(
          `INSERT INTO carries (
             ticket_id, guild_id, customer_discord_id, customer_mc_username,
             carry_type, tier, category, amount, status,
             base_unit_price, base_total_price, final_price, discount_total,
             is_free, is_paid, price_breakdown_json, requested_at, queued_at, free_carry_source, last_activity_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now,
          selectedFreeSource,
          now
        );

      const carryId = Number(carryInsert.lastInsertRowid);
      const priority = this.computePriorityScore({
        isPaid,
        isFree: freeEligible,
        member
      });

      this.db.getConnection().prepare("INSERT INTO queue_entries (carry_id, state, priority_score, created_at) VALUES (?, 'queued', ?, ?)").run(carryId, priority, now);

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
        freeBlockedByType,
        freeBlockedByVerification,
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
    const typeLabel = `${carryType}-${tier}`.toLowerCase();
    const thread = await this.ticketService.ensureForumThreadForTicket(ticketId, {
      type: typeLabel,
      amount: Number(amount),
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
    let failureReason = null;
    const lastFailure = this.db
      .getConnection()
      .prepare("SELECT payload_json FROM events WHERE event_type = 'ticket.thread_create_failed' AND entity_type = 'ticket' AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(ticketId));
    if (lastFailure?.payload_json) {
      try {
        const payload = JSON.parse(String(lastFailure.payload_json));
        if (payload?.error) failureReason = String(payload.error);
      } catch {
        failureReason = null;
      }
    }
    const dashboardId = this.getCarrierDashboardChannelId();
    if (dashboardId && this.client) {
      const channel = await this.client.channels.fetch(dashboardId).catch(() => null);
      if (channel && typeof channel.send === "function") {
        const staffRole = this.getStaffRoleIds()[0];
        const mention = staffRole ? `<@&${staffRole}> ` : "";
        const forumId = this.ticketService?.getTicketLogsForumId?.() || "not set";
        const reasonLine = failureReason ? ` Reason: ${failureReason}` : "";
        await channel
          .send({
            content: `${mention}Carry #${carryId} created but no ticket forum thread was created. Forum: \`${forumId}\`. Check \`/carry-setup\` (Channels -> Ticket Logs Forum) and forum permissions.${reasonLine}`
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

  touchCarryActivity(carryId, ts = Date.now()) {
    const id = Number(carryId);
    if (!Number.isInteger(id) || id <= 0) return;
    this.db
      .getConnection()
      .prepare("UPDATE carries SET last_activity_at = ? WHERE id = ?")
      .run(Number(ts || Date.now()), id);
  }

  touchCarryActivityByChannel(channelId, ts = Date.now()) {
    if (!channelId) return;
    const carry = this.db.getConnection().prepare("SELECT id FROM carries WHERE execution_channel_id = ? ORDER BY id DESC LIMIT 1").get(String(channelId));
    if (!carry?.id) return;
    this.touchCarryActivity(carry.id, ts);
  }

  async autoCloseInactiveCarries() {
    const now = Date.now();
    const inactivityMs = 24 * 60 * 60 * 1000;
    const rows = this.db
      .getConnection()
      .prepare(
        `SELECT *
         FROM carries
         WHERE status IN ('queued', 'claimed', 'in_progress', 'pending_confirm', 'awaiting_rating')
           AND ? - COALESCE(last_activity_at, requested_at, queued_at, started_at, 0) >= ?`
      )
      .all(now, inactivityMs);

    for (const carry of rows) {
      await this.autoCloseInactiveCarry(carry).catch(() => {});
    }
  }

  refundFreeCarryIfUsed(carry) {
    if (!carry || Number(carry.is_free) !== 1 || !carry.customer_discord_id) return { refunded: false, source: null };
    const userId = String(carry.customer_discord_id);
    const source = String(carry.free_carry_source || "").toLowerCase();
    if (source === "weekly") {
      const weekKey = this.getWeekKeyUtc(Number(carry.requested_at || Date.now()));
      const row = this.db.getConnection().prepare("SELECT used_count FROM freecarry_usage WHERE user_id = ? AND week_key = ?").get(userId, weekKey);
      const used = Number(row?.used_count || 0);
      if (used > 0) {
        this.db.getConnection().prepare("UPDATE freecarry_usage SET used_count = MAX(0, used_count - 1) WHERE user_id = ? AND week_key = ?").run(userId, weekKey);
        return { refunded: true, source: "weekly" };
      }
    }

    this.db
      .getConnection()
      .prepare(
        `INSERT INTO freecarry_bonus (user_id, remaining_count, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(user_id)
         DO UPDATE SET remaining_count = remaining_count + 1, updated_at = excluded.updated_at`
      )
      .run(userId, Date.now());
    return { refunded: true, source: source || "bonus" };
  }

  async autoCloseInactiveCarry(carry) {
    const refund = this.refundFreeCarryIfUsed(carry);
    const result = await this.cancelCarry(carry.id, "system", { immediateDelete: true, reason: "inactivity_24h" });
    if (!result?.ok) return result;

    if (carry.ticket_id && this.ticketService) {
      const refundText = refund.refunded ? ` Free carry refunded (${refund.source}).` : "";
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carry #${carry.id} auto-closed after 24h without activity.${refundText}`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
    }
    this.db.logEvent("carry.auto_closed_inactive", "carry", carry.id, {
      inactivityHours: 24,
      refundedFreeCarry: refund.refunded,
      refundSource: refund.source
    });
    return { ok: true };
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

    const adminRoleIds = this.getAdminRoleIds(channel.guild || null);
    for (const roleId of adminRoleIds) {
      await channel.permissionOverwrites.edit(roleId, overwrite).catch(() => {});
    }

    const teamRoleIds = this.getTeamRoleIds(channel.guild || null);
    for (const roleId of teamRoleIds) {
      if (!adminRoleIds.includes(roleId)) {
        await channel.permissionOverwrites.delete(roleId).catch(() => {});
      }
    }

    const legacyStaffIds = this.getStaffRoleIds();
    for (const roleId of legacyStaffIds) {
      if (!adminRoleIds.includes(roleId) && !teamRoleIds.includes(roleId)) {
        await channel.permissionOverwrites.delete(roleId).catch(() => {});
      }
    }
  }

  async claimCarry(carryId, carrierId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (!["queued", "claimed"].includes(carry.status)) return { ok: false, reason: "Carry is not claimable." };

    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    if (!assigned.includes(carrierId)) assigned.push(carrierId);

    this.db.getConnection().prepare("UPDATE carries SET status = 'claimed', assigned_carrier_discord_ids = ? WHERE id = ?").run(JSON.stringify(assigned), carry.id);
    this.touchCarryActivity(carry.id);
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
    this.touchCarryActivity(carry.id);
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

  async forceUnclaimCarry(carryId, actorId) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    if (!["queued", "claimed", "in_progress", "pending_confirm", "awaiting_rating"].includes(String(carry.status))) {
      return { ok: false, reason: "Carry is not active." };
    }

    this.db.getConnection().prepare("UPDATE carries SET status = 'queued', assigned_carrier_discord_ids = '[]' WHERE id = ?").run(carry.id);
    this.db.getConnection().prepare("UPDATE queue_entries SET state = 'queued', claimed_by_discord_id = NULL, stale_notified = 0 WHERE carry_id = ?").run(carry.id);
    this.touchCarryActivity(carry.id);
    this.db.logEvent("carry.force_unclaimed", "carry", carry.id, { actorId });
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
    this.touchCarryActivity(carry.id);

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

    const resolvedCustomerName = await this.resolveCarryCustomerName(guild, carry);
    const typeLabel = `${carry.carry_type || "carry"} ${carry.tier || ""}`.trim();
    const displayName = this.buildCarryDisplayName({
      type: typeLabel,
      amount: carry.amount || "-",
      name: resolvedCustomerName
    });
    const name = displayName;

    const adminRoleIds = this.getAdminRoleIds(guild);
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

    for (const roleId of adminRoleIds) {
      overwrites.push({
        id: roleId,
        type: OverwriteType.Role,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
      });
    }

    let channel = await guild.channels
      .create({
        name,
        type: ChannelType.GuildText,
        parent: parentId,
        topic: displayName,
        permissionOverwrites: overwrites
      })
      .catch((error) => ({ __error: error }));

    if (channel?.__error) {
      const fallbackName = this.sanitizeTextChannelName(displayName);
      channel = await guild.channels
        .create({
          name: fallbackName,
          type: ChannelType.GuildText,
          parent: parentId,
          topic: displayName,
          permissionOverwrites: overwrites
        })
        .catch((error) => ({ __error: error }));
    }

    if (!channel || channel.__error) {
      return {
        ok: false,
        reason: `Failed to create carry execution channel${channel?.__error?.message ? `: ${channel.__error.message}` : "."}`
      };
    }

    const panelMessage = await channel.send(this.buildExecutionPanelPayload(carry));
    this.db.getConnection().prepare("UPDATE carries SET execution_message_id = ? WHERE id = ?").run(panelMessage.id, carry.id);
    const quickMessage = await channel.send(this.buildExecutionQuickPanelPayload(carry)).catch(() => null);
    if (quickMessage?.id) {
      this.setQuickPanelMessageId(carry.id, quickMessage.id);
      await this.cleanupDuplicateQuickPanels(channel, carry, quickMessage.id).catch(() => {});
    }

    return { ok: true, channel };
  }

  async resolveCarryCustomerName(guild, carry) {
    if (carry?.customer_discord_id) {
      const member = guild ? await guild.members.fetch(String(carry.customer_discord_id)).catch(() => null) : null;
      if (member?.user?.username) return String(member.user.username);
      const user = this.client ? await this.client.users.fetch(String(carry.customer_discord_id)).catch(() => null) : null;
      if (user?.username) return String(user.username);
    }

    if (carry?.ticket_id) {
      const ticket = this.db.getConnection().prepare("SELECT customer_username FROM tickets WHERE id = ?").get(Number(carry.ticket_id));
      const username = String(ticket?.customer_username || "")
        .trim()
        .replace(/#\d{4,}$/g, "");
      if (username) return username;
    }

    return "customer";
  }

  buildExecutionPanelPayload(carry) {
    const breakdown = this.safePriceBreakdown(carry?.price_breakdown_json);
    const coverage = this.getPaymentCoverage(carry);
    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    const carrierLabel = assigned.length
      ? assigned
          .map((id) => `<@${id}>`)
          .join(", ")
          .slice(0, 1024)
      : "Unassigned";
    const scopePct = Number(breakdown?.scopeDiscount?.percentage || 0);
    const bulkPct = Number(breakdown?.bulkDiscount?.percentage || 0);
    const freeReduction = Number(breakdown?.freeReduction || 0);
    const scopeLabel = scopePct > 0 ? `${scopePct}% (${breakdown?.scopeDiscount?.scope || "scope"})` : "None";
    const bulkLabel = bulkPct > 0 ? `${bulkPct}%` : "None";
    const freeLabel = Number(carry?.is_free) === 1 || freeReduction > 0 ? `Yes (-${this.formatCoinsShort(freeReduction || 0)})` : "No";

    const status = String(carry.status || "queued").toLowerCase();
    const statusIcon =
      status === "completed"
        ? "⚫ Completed"
        : status === "pending_confirm"
          ? "🟡 Pending Confirm"
          : status === "cancelled"
            ? "🔴 Cancelled"
            : status === "queued"
              ? "🟡 Waiting for Carrier"
              : "🟢 In Progress";

    const actions = this.buildExecutionComponents(carry);
    const panel = makePanel({
      title: `Carry #${carry.id}`,
      status: statusIcon,
      sections: [
        {
          title: "Customer Info",
          lines: [
            `- Customer: ${carry.customer_discord_id ? `<@${carry.customer_discord_id}>` : "Unknown"}`,
            `- Order Type: **${carry.carry_type} ${carry.tier}**`,
            `- Amount: **${carry.amount}**`,
            `- Carrier(s): ${carrierLabel}`
          ]
        },
        {
          title: "Payment",
          lines: [
            `- Unit Price: **${this.formatCoinsShort(carry.base_unit_price || 0)}**`,
            `- Total: **${this.formatCoinsShort(carry.final_price)}**`,
            `- Paid: **${this.formatCoinsShort(carry.paid_amount || 0)}**`,
            `- Remaining: **${this.formatCoinsShort(coverage.remainingPayment || 0)}**`
          ]
        },
        {
          title: "Progress",
          lines: [
            `- Runs Completed: **${Number(carry.logged_runs || 0)}/${Number(carry.amount || 0)}**`,
            `- Scope Discount: ${scopeLabel}`,
            `- Bulk Discount: ${bulkLabel}`,
            `- Free Carry Used: ${freeLabel}`
          ]
        }
      ],
      actions,
      tabs: [
        actionButton(`${CARRY_PREFIX}toggle:payment:${carry.id}`, "Payment Details", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}toggle:audit:${carry.id}`, "Audit Details", ButtonStyle.Secondary)
      ],
      accentColor: 0x1abc9c
    });
    return panelPayload(panel);
  }

  getQuickPanelMap() {
    const raw = String(this.db.getBinding(CARRY_QUICK_PANEL_MAP_KEY, "{}") || "{}");
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  setQuickPanelMap(nextMap) {
    this.db.setBinding(CARRY_QUICK_PANEL_MAP_KEY, JSON.stringify(nextMap || {}));
  }

  getQuickPanelMessageId(carryId) {
    const map = this.getQuickPanelMap();
    return map[String(carryId)] ? String(map[String(carryId)]) : null;
  }

  setQuickPanelMessageId(carryId, messageId) {
    const map = this.getQuickPanelMap();
    if (!messageId) {
      delete map[String(carryId)];
    } else {
      map[String(carryId)] = String(messageId);
    }
    this.setQuickPanelMap(map);
  }

  extractComponentCustomIds(nodes, acc = []) {
    if (!Array.isArray(nodes) || !nodes.length) return acc;
    for (const node of nodes) {
      if (!node) continue;
      const customId = node.customId || node.custom_id || node?.data?.custom_id || null;
      if (typeof customId === "string" && customId.length > 0) acc.push(customId);
      if (Array.isArray(node.components) && node.components.length) {
        this.extractComponentCustomIds(node.components, acc);
      }
      if (Array.isArray(node?.data?.components) && node.data.components.length) {
        this.extractComponentCustomIds(node.data.components, acc);
      }
    }
    return acc;
  }

  isQuickPanelMessageForCarry(message, carry) {
    if (!message || !carry) return false;
    if (!this.client?.user?.id || String(message.author?.id || "") !== String(this.client.user.id)) return false;
    if (String(message.id) === String(carry.execution_message_id || "")) return false;

    const carryId = Number(carry.id);
    if (!Number.isInteger(carryId)) return false;

    const allCustomIds = this.extractComponentCustomIds(message.components || []);
    if (!allCustomIds.length) return false;
    const carryCustomIds = allCustomIds.filter((id) => typeof id === "string" && id.endsWith(`:${carryId}`));
    if (!carryCustomIds.length) return false;

    const hasMainOnlyAction = carryCustomIds.some((id) => id.startsWith(`${CARRY_PREFIX}close_ticket:`) || id.startsWith(`${CARRY_PREFIX}reassign:`));
    if (hasMainOnlyAction) return false;

    return carryCustomIds.some(
      (id) =>
        id.startsWith(`${CARRY_PREFIX}claim:`) ||
        id.startsWith(`${CARRY_PREFIX}assign:`) ||
        id.startsWith(`${CARRY_PREFIX}reping:`) ||
        id.startsWith(`${CARRY_PREFIX}log_runs:`) ||
        id.startsWith(`${CARRY_PREFIX}mark_paid:`) ||
        id.startsWith(`${CARRY_PREFIX}unclaim:`) ||
        id.startsWith(`${CARRY_PREFIX}view:logs:`) ||
        id.startsWith(`${CARRY_PREFIX}reopen:`)
    );
  }

  async cleanupDuplicateQuickPanels(channel, carry, keepMessageId) {
    if (!channel || !carry) return;
    const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!fetched) return;

    const keepId = keepMessageId ? String(keepMessageId) : null;
    for (const msg of fetched.values()) {
      if (!this.isQuickPanelMessageForCarry(msg, carry)) continue;
      if (keepId && String(msg.id) === keepId) continue;
      await msg.delete().catch(() => {});
    }
  }

  buildExecutionQuickPanelPayload(carry) {
    const coverage = this.getPaymentCoverage(carry);
    const status = String(carry.status || "queued").toLowerCase();
    const summary = [
      `- Status: **${status}** | Runs: **${Number(carry.logged_runs || 0)}/${Number(carry.amount || 0)}**`,
      `- Paid: **${this.formatCoinsShort(carry.paid_amount || 0)}** | Remaining: **${this.formatCoinsShort(coverage.remainingPayment || 0)}**`
    ];

    const actions = [];
    if (["claimed", "in_progress", "pending_confirm", "awaiting_rating"].includes(status)) {
      actions.push(
        actionButton(`${CARRY_PREFIX}log_runs:${carry.id}`, "Log Runs", ButtonStyle.Primary),
        actionButton(`${CARRY_PREFIX}mark_paid:${carry.id}`, "Mark Paid", ButtonStyle.Success),
        actionButton(`${CARRY_PREFIX}reping:${carry.id}`, "Re-Ping Customer", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}unclaim:${carry.id}`, "Unclaim", ButtonStyle.Secondary)
      );
    } else if (status === "queued") {
      actions.push(
        actionButton(`${CARRY_PREFIX}claim:${carry.id}`, "Claim Carry", ButtonStyle.Primary),
        actionButton(`${CARRY_PREFIX}assign:${carry.id}`, "Assign Carrier", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}reping:${carry.id}`, "Re-Ping Carriers", ButtonStyle.Secondary)
      );
    } else if (["completed", "cancelled"].includes(status)) {
      actions.push(
        actionButton(`${CARRY_PREFIX}view:logs:${carry.id}`, "View Logs", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}reopen:${carry.id}`, "Reopen", ButtonStyle.Primary)
      );
    }

    return panelPayload(
      makePanel({
        title: `Carry #${carry.id} Quick`,
        sections: [{ title: "Summary", lines: summary }],
        actions,
        accentColor: 0x3498db
      })
    );
  }

  buildExecutionComponents(carry) {
    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    const status = String(carry.status || "queued").toLowerCase();
    if (["completed", "cancelled"].includes(status)) {
      return [
        actionButton(`${CARRY_PREFIX}view:logs:${carry.id}`, "View Logs", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}reopen:${carry.id}`, "Reopen", ButtonStyle.Primary)
      ];
    }

    if (assigned.length === 0 || status === "queued") {
      return [
        actionButton(`${CARRY_PREFIX}claim:${carry.id}`, "Claim Carry", ButtonStyle.Primary),
        actionButton(`${CARRY_PREFIX}assign:${carry.id}`, "Assign Carrier", ButtonStyle.Secondary),
        actionButton(`${CARRY_PREFIX}close_ticket:${carry.id}`, "Cancel Request", ButtonStyle.Danger)
      ];
    }

    return [
      actionButton(`${CARRY_PREFIX}log_runs:${carry.id}`, "Log Runs", ButtonStyle.Primary),
      actionButton(`${CARRY_PREFIX}mark_paid:${carry.id}`, "Mark Paid", ButtonStyle.Success),
      actionButton(`${CARRY_PREFIX}unclaim:${carry.id}`, "Unclaim", ButtonStyle.Secondary),
      actionButton(`${CARRY_PREFIX}reassign:${carry.id}`, "Reassign", ButtonStyle.Secondary),
      actionButton(`${CARRY_PREFIX}reping:${carry.id}`, "Re-Ping Customer", ButtonStyle.Secondary),
      actionButton(`${CARRY_PREFIX}close_ticket:${carry.id}`, "Close Ticket", ButtonStyle.Danger)
    ];
  }

  async refreshExecutionPanel(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry?.execution_channel_id || !carry?.execution_message_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const mainPayload = this.buildExecutionPanelPayload(carry);
    const mainMessage = await channel.messages.fetch(carry.execution_message_id).catch(() => null);
    if (mainMessage) await mainMessage.edit(mainPayload).catch(() => {});

    const quickPayload = this.buildExecutionQuickPanelPayload(carry);
    const quickId = this.getQuickPanelMessageId(carry.id);
    const quickMessage = quickId ? await channel.messages.fetch(quickId).catch(() => null) : null;
    if (!quickMessage) {
      const posted = await channel.send(quickPayload).catch(() => null);
      if (posted?.id) {
        this.setQuickPanelMessageId(carry.id, posted.id);
        await this.cleanupDuplicateQuickPanels(channel, carry, posted.id).catch(() => {});
      }
      return;
    }

    const latest = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    const latestId = latest?.first?.()?.id || null;
    if (latestId && latestId !== quickMessage.id) {
      const posted = await channel.send(quickPayload).catch(() => null);
      if (posted?.id) {
        this.setQuickPanelMessageId(carry.id, posted.id);
        await quickMessage.delete().catch(() => {});
        await this.cleanupDuplicateQuickPanels(channel, carry, posted.id).catch(() => {});
      }
      return;
    }

    await quickMessage.edit(quickPayload).catch(() => {});
    await this.cleanupDuplicateQuickPanels(channel, carry, quickMessage.id).catch(() => {});
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
      this.upsertCarrierStatsOnCompletion(carrierId, duration, true, { ticketIncrement: 1 });
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

    await this.closeExecutionChannel(carry.execution_channel_id, { announce: true });
    this.db.logEvent("carry.completed", "carry", carry.id, { duration });
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    await this.publishCarrierStatsDashboard().catch(() => {});
  }

  upsertCarrierStatsOnCompletion(carrierId, duration, accepted, options = {}) {
    const now = Date.now();
    const ticketIncrement = Number(options.ticketIncrement || 0);
    const current = this.db.getConnection().prepare("SELECT * FROM carrier_stats WHERE user_id = ?").get(carrierId);
    if (!current) {
      this.db
        .getConnection()
        .prepare(
          "INSERT INTO carrier_stats (user_id, completed_count, completed_tickets_count, actual_carries_count, score_total, total_duration_ms, acceptance_rate, active_hours_json, updated_at) VALUES (?, 1, ?, 0, 0, ?, ?, ?, ?)"
        )
        .run(carrierId, ticketIncrement, duration, accepted ? 1 : 0, JSON.stringify([new Date(now).getUTCHours()]), now);
      return;
    }

    const completed = Number(current.completed_count || 0) + 1;
    const completedTickets = Number(current.completed_tickets_count || 0) + ticketIncrement;
    const totalDuration = Number(current.total_duration_ms || 0) + duration;
    const prevRate = Number(current.acceptance_rate || 0.8);
    const nextRate = Math.max(0.1, Math.min(1, prevRate * 0.8 + (accepted ? 1 : 0) * 0.2));
    const hours = new Set(JSON.parse(current.active_hours_json || "[]"));
    hours.add(new Date(now).getUTCHours());

    this.db
      .getConnection()
      .prepare(
        "UPDATE carrier_stats SET completed_count = ?, completed_tickets_count = ?, total_duration_ms = ?, acceptance_rate = ?, active_hours_json = ?, updated_at = ? WHERE user_id = ?"
      )
      .run(completed, completedTickets, totalDuration, nextRate, JSON.stringify([...hours]), now, carrierId);
  }

  addCarrierRunScore(carrierId, carry, runs) {
    if (!carrierId || !carry) return;
    const now = Date.now();
    const addRuns = Math.max(0, Number(runs || 0));
    if (!addRuns) return;
    const weight = this.getScoreWeight(carry.carry_type, carry.tier);
    const addScore = addRuns * weight;

    this.db
      .getConnection()
      .prepare(
        `INSERT INTO carrier_stats (user_id, completed_count, completed_tickets_count, actual_carries_count, score_total, total_duration_ms, acceptance_rate, active_hours_json, updated_at)
         VALUES (?, 0, 0, ?, ?, 0, 0.8, ?, ?)
         ON CONFLICT(user_id)
         DO UPDATE SET
           actual_carries_count = COALESCE(actual_carries_count, 0) + excluded.actual_carries_count,
           score_total = COALESCE(score_total, 0) + excluded.score_total,
           updated_at = excluded.updated_at`
      )
      .run(String(carrierId), addRuns, addScore, JSON.stringify([new Date(now).getUTCHours()]), now);
  }

  async cancelCarry(carryId, actorId, options = {}) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };

    const now = Date.now();
    const actorLabel = /^\d{17,20}$/.test(String(actorId || "")) ? `<@${actorId}>` : String(actorId || "system");
    const reason = options.reason ? ` (${options.reason})` : "";
    this.db.getConnection().prepare("UPDATE carries SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now, carry.id);
    this.db.getConnection().prepare("UPDATE queue_entries SET state = 'cancelled' WHERE carry_id = ?").run(carry.id);

    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carry #${carry.id} cancelled by ${actorLabel}.${reason}`,
        username: "Carry System",
        avatarURL: null,
        viaWebhook: true
      });
      await this.ticketService.closeTicket(carry.ticket_id);
    }

    await this.closeExecutionChannel(carry.execution_channel_id, { immediate: Boolean(options.immediateDelete) });
    this.setQuickPanelMessageId(carry.id, null);
    this.db.logEvent("carry.cancelled", "carry", carry.id, { actorId });
    await this.syncCarryTicketIndicators(carry.id);
    await this.publishCarrierDashboard();
    return { ok: true };
  }

  async closeExecutionChannel(channelId, options = {}) {
    if (!channelId || !this.client) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const delayMs = options.immediate ? 1000 : Math.max(10000, this.getCarryAutoDeleteMs());
    if (options.announce) {
      await channel
        .send(
          panelPayload(
            makePanel({
              title: "Carry Completed",
              sections: [{ title: "Channel Closure", lines: [`Closing ticket in ${Math.round(delayMs / 1000)}s.`] }],
              accentColor: 0x95a5a6
            })
          )
        )
        .catch(() => {});
    }

    await channel.permissionOverwrites
      .edit(channel.guild.roles.everyone.id, {
        SendMessages: false
      })
      .catch(() => {});

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

    const addAmount = this.parseCoinsInput(amount);
    if (!Number.isFinite(addAmount) || addAmount <= 0) {
      return { ok: false, reason: "Invalid payment amount. Use positive values like 300000, 300k, or 1.5m." };
    }
    this.db
      .getConnection()
      .prepare("UPDATE carries SET is_paid = CASE WHEN ? > 0 THEN 1 ELSE is_paid END, paid_amount = COALESCE(paid_amount, 0) + ? WHERE id = ?")
      .run(addAmount, addAmount, carry.id);
    this.touchCarryActivity(carry.id);
    const priority = this.computePriorityScore({ isPaid: true, isFree: Number(carry.is_free) === 1, member: null });
    this.db.getConnection().prepare("UPDATE queue_entries SET priority_score = ? WHERE carry_id = ? AND state IN ('queued','claimed')").run(priority, carry.id);

    const refreshed = this.getCarryById(carry.id);
    const coverage = this.getPaymentCoverage(refreshed);
    this.db.logEvent("carry.mark_paid", "carry", carry.id, { actorId, amount: addAmount, coverage });
    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Payment logged on carry #${carry.id}: +${this.formatCoinsShort(addAmount)}. Total paid: ${this.formatCoinsShort(coverage.paidAmount)}. Covers ${coverage.coveredRuns}/${coverage.amount} runs. Remaining payment: ${this.formatCoinsShort(coverage.remainingPayment)}.`,
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
      ...panelPayload(
        makePanel({
          title: `Run Log Warning - Carry #${carry.id}`,
          status: "Confirmation Required",
          sections: [{ title: "Warnings", lines: [`- Requested by: <@${actorId}>`, ...warnings.map((w) => `- ${w}`)] }],
          actions: [
            actionButton(`${CARRY_PREFIX}confirm_log_runs:${carry.id}:${addRuns}:${actorId}`, "Confirm", ButtonStyle.Success),
            actionButton(`${CARRY_PREFIX}cancel_log_runs:${carry.id}:${actorId}`, "Cancel", ButtonStyle.Secondary),
            actionButton(`${CARRY_PREFIX}warn_add_paid:${carry.id}:${actorId}`, "Forgot Paid Amount", ButtonStyle.Primary)
          ],
          accentColor: 0xe67e22
        })
      )
    });
  }

  async postCustomerOverlogPrompt(carryId) {
    const carry = this.getCarryById(carryId);
    if (!carry?.execution_channel_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.send({
      ...panelPayload(
        makePanel({
          title: `Over-Target Run Confirmation - Carry #${carry.id}`,
          status: "Customer Confirmation",
          sections: [
            {
              title: "Pending",
              lines: [
                carry.customer_discord_id ? `- Customer: <@${carry.customer_discord_id}>` : "- Customer: Unknown",
                `- Pending add: **${carry.pending_log_runs}**`,
                `- Current: **${carry.logged_runs}/${carry.amount}**`,
                "- Carrier is trying to log beyond requested runs."
              ]
            }
          ],
          actions: [
            actionButton(`${CARRY_PREFIX}customer_confirm_overlog:${carry.id}`, "Confirm Extra Runs", ButtonStyle.Success),
            actionButton(`${CARRY_PREFIX}customer_cancel_overlog:${carry.id}`, "Cancel", ButtonStyle.Danger)
          ],
          accentColor: 0xe74c3c
        })
      )
    });
  }

  async applyLoggedRuns(carryId, actorId, addRuns) {
    const carry = this.getCarryById(carryId);
    const nextRuns = Number(carry.logged_runs || 0) + Number(addRuns || 0);
    const reached = nextRuns >= Number(carry.amount || 0);
    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    if (actorId && !assigned.includes(String(actorId))) {
      assigned.push(String(actorId));
    }
    this.db
      .getConnection()
      .prepare(
        "UPDATE carries SET logged_runs = ?, status = ?, started_at = COALESCE(started_at, ?), assigned_carrier_discord_ids = ?, pending_log_runs = 0, pending_log_actor_id = NULL WHERE id = ?"
      )
      .run(nextRuns, reached ? "pending_confirm" : "in_progress", Date.now(), JSON.stringify(assigned), carry.id);
    this.db.logEvent("carry.log_runs", "carry", carry.id, { actorId, runs: addRuns, total: nextRuns });
    this.addCarrierRunScore(actorId, carry, addRuns);
    if (carry.ticket_id && this.ticketService) {
      await this.ticketService.mirrorMessage(carry.ticket_id, {
        content: `Carrier <@${actorId}> logged runs for carry #${carry.id}: +${addRuns} (total ${nextRuns}/${carry.amount}).`,
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

    this.touchCarryActivity(carry.id);
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
        ...panelPayload(
          makePanel({
            title: `Confirm Carry #${carry.id}`,
            status: "Pending Customer Confirm",
            sections: [
              {
                title: "Completion",
                lines: [
                  carry.customer_discord_id ? `- Customer: <@${carry.customer_discord_id}>` : "- Customer: Unknown",
                  "Carrier marked all runs complete. Confirm completion."
                ]
              }
            ],
            actions: [actionButton(`${CARRY_PREFIX}confirm_complete:${carry.id}`, "Confirm Complete", ButtonStyle.Success)],
            accentColor: 0x3498db
          })
        )
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
        ...panelPayload(
          makePanel({
            title: `Rate Carry #${carry.id}`,
            status: "Awaiting Rating",
            sections: [
              {
                title: "Feedback",
                lines: [carry.customer_discord_id ? `- Customer: <@${carry.customer_discord_id}>` : "- Customer: Unknown", "Please rate your carry experience (1-5)."]
              }
            ],
            actions: [
              actionButton(`${CARRY_PREFIX}rate:${carry.id}:1`, "1", ButtonStyle.Secondary),
              actionButton(`${CARRY_PREFIX}rate:${carry.id}:2`, "2", ButtonStyle.Secondary),
              actionButton(`${CARRY_PREFIX}rate:${carry.id}:3`, "3", ButtonStyle.Primary),
              actionButton(`${CARRY_PREFIX}rate:${carry.id}:4`, "4", ButtonStyle.Success),
              actionButton(`${CARRY_PREFIX}rate:${carry.id}:5`, "5", ButtonStyle.Success)
            ],
            accentColor: 0xf39c12
          })
        )
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
    this.touchCarryActivity(carry.id);
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

    const coverage = this.getPaymentCoverage(carry);
    const hasLoggedRuns = Number(carry.logged_runs || 0) > 0;
    const hasAnyPayment = Number(carry.paid_amount || 0) > 0;
    const hasPartialPayment = hasAnyPayment && Number(coverage.remainingPayment || 0) > 0;
    const isZeroProgress = !hasLoggedRuns && !hasAnyPayment;

    if (isZeroProgress) {
      this.touchCarryActivity(carry.id);
      return this.cancelCarry(carryId, actorId, { immediateDelete: true });
    }

    this.touchCarryActivity(carry.id);
    await this.postCloseTicketConfirmation(carry, actorId, { hasLoggedRuns, hasAnyPayment, hasPartialPayment, coverage });
    return { ok: false, needsConfirm: true, reason: "Close requires confirmation. A confirm embed was posted in this channel." };
  }

  async postCloseTicketConfirmation(carry, actorId, status) {
    if (!carry?.execution_channel_id || !this.client) return;
    const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const reasons = [];
    if (status.hasLoggedRuns) reasons.push(`Logged runs: **${Number(carry.logged_runs || 0)}/${Number(carry.amount || 0)}**`);
    if (status.hasAnyPayment) reasons.push(`Paid: **${this.formatCoinsShort(carry.paid_amount || 0)}**`);
    if (status.hasPartialPayment) reasons.push(`Remaining payment: **${this.formatCoinsShort(status.coverage?.remainingPayment || 0)}**`);

    await channel.send({
      ...panelPayload(
        makePanel({
          title: `Confirm Close - Carry #${carry.id}`,
          status: "Requires Confirmation",
          sections: [
            {
              title: "Impact",
              lines: [
                `- Requested By: <@${actorId}>`,
                "This ticket has progress/payment data.",
                ...reasons.map((r) => `- ${r}`),
                "",
                "Confirm to force-close and cancel."
              ]
            }
          ],
          actions: [
            actionButton(`${CARRY_PREFIX}close_confirm:${carry.id}:${actorId}`, "Confirm Close", ButtonStyle.Danger),
            actionButton(`${CARRY_PREFIX}close_cancel:${carry.id}:${actorId}`, "Keep Open", ButtonStyle.Secondary)
          ],
          accentColor: 0xe67e22
        })
      )
    });
  }

  async repingCarriers(carryId, actorId, isStaffActor = false) {
    const carry = this.getCarryById(carryId);
    if (!carry) return { ok: false, reason: "Carry not found." };
    const status = String(carry.status || "").toLowerCase();
    const isCustomer = String(carry.customer_discord_id) === String(actorId);
    const assigned = JSON.parse(carry.assigned_carrier_discord_ids || "[]");
    const isAssignedCarrier = assigned.includes(String(actorId));

    if (status === "queued") {
      if (!isCustomer && !isStaffActor) return { ok: false, reason: "Only customer or staff can reping." };

      const now = Date.now();
      const ageMs = now - Number(carry.queued_at || carry.requested_at || now);
      if (ageMs < 6 * 60 * 60 * 1000) return { ok: false, reason: "Reping is available after 6 hours unclaimed." };
      if (carry.reping_last_at && now - Number(carry.reping_last_at) < 60 * 60 * 1000) return { ok: false, reason: "Reping cooldown active (1h)." };
      if (!this.hadCarrierOnlineBetween(Number(carry.queued_at || carry.requested_at || now), now)) {
        return { ok: false, reason: "No carriers were online during this unclaimed window." };
      }

      await this.ghostPingCarrierRole(carry.id);
      this.db.getConnection().prepare("UPDATE carries SET reping_last_at = ? WHERE id = ?").run(now, carry.id);
      this.touchCarryActivity(carry.id);
      this.db.logEvent("carry.reping", "carry", carry.id, { actorId, mode: "carrier_queue_ping" });
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

    if (["claimed", "in_progress", "pending_confirm", "awaiting_rating"].includes(status)) {
      if (!isAssignedCarrier && !isStaffActor) return { ok: false, reason: "Only assigned carrier or staff can re-ping the customer." };
      if (!carry.customer_discord_id) return { ok: false, reason: "No customer linked to this carry." };
      if (!carry.execution_channel_id || !this.client) return { ok: false, reason: "Execution channel is unavailable." };
      const channel = await this.client.channels.fetch(carry.execution_channel_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) return { ok: false, reason: "Execution channel is unavailable." };
      await channel.send({ content: `<@${carry.customer_discord_id}>` }).catch(() => null);
      this.touchCarryActivity(carry.id);
      this.db.logEvent("carry.reping", "carry", carry.id, { actorId, mode: "customer_ping" });
      if (carry.ticket_id && this.ticketService) {
        await this.ticketService.mirrorMessage(carry.ticket_id, {
          content: `Customer reping sent for carry #${carry.id} by <@${actorId}>.`,
          username: "Carry System",
          avatarURL: null,
          viaWebhook: true
        });
      }
      return { ok: true };
    }

    return { ok: false, reason: "Reping is not available for this carry status." };
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

    if (parsed.action === "admin_target") {
      if (!this.isAdmin(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only Service-Admin can use this panel."], ephemeral: true }));
        return true;
      }
      const selected = String(interaction.values?.[0] || "");
      const carryId = /^\d+$/.test(selected) ? Number(selected) : null;
      this.setCarryAdminState(interaction.message?.id || "0", interaction.user?.id || "0", carryId);
      await interaction.update(this.buildCarryAdminPanel({ messageId: interaction.message?.id || "0", actorId: interaction.user?.id || "0" })).catch(async () => {
        await interaction.reply(infoPayload({ title: "Carry Admin", lines: ["Panel refreshed."], ephemeral: true }));
      });
      return true;
    }

    if (["admin_refresh", "admin_force_unclaim", "admin_force_reassign", "admin_view_logs"].includes(parsed.action)) {
      if (!this.isAdmin(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only Service-Admin can use this panel."], ephemeral: true }));
        return true;
      }

      const messageId = interaction.message?.id || "0";
      const actorId = interaction.user?.id || "0";
      const state = this.getCarryAdminState(messageId, actorId);
      const targetCarryId = Number(state.targetCarryId || 0);
      const target = targetCarryId > 0 ? this.getCarryById(targetCarryId) : null;

      if (parsed.action === "admin_refresh") {
        await interaction.update(this.buildCarryAdminPanel({ messageId, actorId }));
        return true;
      }

      if (!target) {
        await interaction.reply(infoPayload({ title: "Carry Admin", lines: ["No valid carry selected."], ephemeral: true }));
        return true;
      }

      if (parsed.action === "admin_force_unclaim") {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const result = await this.forceUnclaimCarry(target.id, interaction.user.id);
        await interaction.editReply(
          infoPayload({ title: "Force Unclaim", lines: [result.ok ? `Carry #${target.id} moved back to queue.` : result.reason], ephemeral: true })
        );
        return true;
      }

      if (parsed.action === "admin_force_reassign") {
        const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}admin_reassign:${target.id}`).setTitle(`Force Reassign #${target.id}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("carrier_ids").setLabel("Carrier IDs (comma separated)").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return true;
      }

      const transcript = await this.buildChannelTranscript(target.execution_channel_id);
      await interaction.reply(
        infoPayload({
          title: `Carry #${target.id} Logs`,
          lines: [transcript ? `\`\`\`\n${transcript.slice(0, 1800)}\n\`\`\`` : "No logs available."],
          ephemeral: true
        })
      );
      return true;
    }

    if (parsed.action === "view") {
      const [scope, viewKey] = String(parsed.rawId || "").split(":");
      const messageId = interaction.message?.id || "0";
      const actorId = interaction.user?.id || "0";
      this.setPanelState(scope, messageId, actorId, { viewKey: viewKey || "overview", page: 1 });
      if (scope === "carry_dashboard") {
        const payload = this.buildCarryDashboardPanel({ viewKey: viewKey || "overview", page: 1 });
        await interaction.update(payload).catch(async () => {
          await this.publishCarryDashboard(null, { viewKey: viewKey || "overview", page: 1 });
        });
        return true;
      }
      if (scope === "logs" && Number.isInteger(Number(viewKey))) {
        const carryId = Number(viewKey);
        const transcript = await this.buildChannelTranscript(this.getCarryById(carryId)?.execution_channel_id);
        await interaction.reply(
          infoPayload({
            title: `Carry #${carryId} Logs`,
            lines: [transcript ? `\`\`\`\n${transcript.slice(0, 1800)}\n\`\`\`` : "No logs available."],
            ephemeral: true
          })
        );
        return true;
      }
    }

    if (parsed.action === "page") {
      const [scope, nextPageRaw] = String(parsed.rawId || "").split(":");
      const nextPage = Math.max(1, Number(nextPageRaw || 1));
      const messageId = interaction.message?.id || "0";
      const actorId = interaction.user?.id || "0";
      const current = this.getPanelState(scope, messageId, actorId);
      this.setPanelState(scope, messageId, actorId, { viewKey: current.viewKey, page: nextPage, expanded: current.expanded });

      if (scope === "carry_dashboard") {
        await interaction.update(this.buildCarryDashboardPanel({ viewKey: current.viewKey, page: nextPage }));
        return true;
      }
      if (scope === "carrier_dashboard") {
        await this.publishCarrierDashboard(null, { page: nextPage });
        await interaction.reply(infoPayload({ title: "Carrier Dashboard", lines: [`Moved to page ${nextPage}.`], ephemeral: true }));
        return true;
      }
      if (scope === "stats_dashboard") {
        await this.publishCarrierStatsDashboard(null, { page: nextPage });
        await interaction.reply(infoPayload({ title: "Carrier Stats", lines: [`Moved to page ${nextPage}.`], ephemeral: true }));
        return true;
      }
    }

    if (parsed.action === "jump") {
      const [scope] = String(parsed.rawId || "").split(":");
      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}jump:${scope}`).setTitle("Jump To Page");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("page").setLabel("Page").setStyle(TextInputStyle.Short).setRequired(true))
      );
      await interaction.showModal(modal);
      return true;
    }

    if (parsed.action === "toggle") {
      const [section, carryIdRaw] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      const carry = this.getCarryById(carryId);
      if (!carry) {
        await interaction.reply(infoPayload({ title: "Toggle Failed", lines: ["Carry not found."], ephemeral: true }));
        return true;
      }

      if (section === "payment") {
        const breakdown = this.safePriceBreakdown(carry.price_breakdown_json);
        await interaction.reply(
          infoPayload({
            title: `Payment Details - Carry #${carry.id}`,
            lines: [
              `Base Total: ${this.formatCoinsShort(breakdown?.baseTotal ?? carry.base_total_price ?? 0)}`,
              `Scope Discount: ${Number(breakdown?.scopeDiscount?.percentage || 0)}%`,
              `Bulk Discount: ${Number(breakdown?.bulkDiscount?.percentage || 0)}%`,
              `Final: ${this.formatCoinsShort(carry.final_price)}`
            ],
            ephemeral: true
          })
        );
        return true;
      }

      await interaction.reply(
        infoPayload({
          title: `Audit Details - Carry #${carry.id}`,
          lines: [
            `Requested: <t:${Math.floor(Number(carry.requested_at || Date.now()) / 1000)}:f>`,
            `Started: ${carry.started_at ? `<t:${Math.floor(Number(carry.started_at) / 1000)}:f>` : "n/a"}`,
            `Completed: ${carry.completed_at ? `<t:${Math.floor(Number(carry.completed_at) / 1000)}:f>` : "n/a"}`
          ],
          ephemeral: true
        })
      );
      return true;
    }

    if (parsed.action === "bulk") {
      if (!this.isStaff(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only staff can run bulk actions."], ephemeral: true }));
        return true;
      }
      const bulkAction = String(parsed.rawId || "");
      if (["claim_next_3", "close_completed"].includes(bulkAction)) {
        const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}bulk:${bulkAction}`).setTitle("Confirm Bulk Action");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("confirm").setLabel("Type CONFIRM to continue").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("CONFIRM")
          )
        );
        await interaction.showModal(modal);
        return true;
      }
    }

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
      const verified = this.isVerifiedForFreeCarry(interaction.member, userId);
      await interaction.reply(
        infoPayload({
          title: "Free Carry Status",
          lines: [
            `- Week: **${status.weekKey}**`,
            `- Verified: **${verified ? "Yes" : "No"}**`,
            `- Weekly Free Carries: **${status.weeklyRemaining}/${status.limit}** remaining (${status.used} used)`,
            `- Bonus Credits: **${status.bonusRemaining}**`,
            `- Total Available: **${status.totalRemaining}**`,
            "- Free carry is excluded for **Kuudra** and **Dungeons M7**."
          ],
          ephemeral: true
        })
      );
      return true;
    }

    if (parsed.action === "carry_refresh") {
      const messageId = interaction.message?.id || this.db.getBinding("carry_dashboard_message_id", "0");
      const actorId = interaction.user?.id || "0";
      const state = this.getPanelState("carry_dashboard", messageId, actorId);
      await interaction.update(this.buildCarryDashboardPanel({ viewKey: state.viewKey, page: state.page })).catch(async () => {
        await this.publishCarryDashboard(null, { viewKey: state.viewKey, page: state.page });
        await interaction.reply(infoPayload({ title: "Carry Dashboard", lines: ["Dashboard refreshed."], ephemeral: true }));
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
      await interaction.reply(infoPayload({ title: "Carrier Pick", lines: [result.ok ? `Claimed carry #${carryId}.` : result.reason], ephemeral: true }));
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

    if (parsed.action === "close_confirm") {
      const [carryIdRaw, actorId] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      if (!Number.isInteger(carryId) || !actorId) {
        await interaction.reply({ content: "Invalid close confirmation payload.", ephemeral: true });
        return true;
      }
      if (String(interaction.user.id) !== String(actorId) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only the requesting user or staff can confirm close.", ephemeral: true });
        return true;
      }
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const result = await this.cancelCarry(carryId, interaction.user.id, { immediateDelete: true });
      await interaction.editReply({ content: result.ok ? `Carry #${carryId} force-closed.` : result.reason });
      return true;
    }

    if (parsed.action === "close_cancel") {
      const [carryIdRaw, actorId] = String(parsed.rawId || "").split(":");
      const carryId = Number(carryIdRaw);
      if (!Number.isInteger(carryId) || !actorId) {
        await interaction.reply({ content: "Invalid close cancellation payload.", ephemeral: true });
        return true;
      }
      if (String(interaction.user.id) !== String(actorId) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only the requesting user or staff can cancel this close.", ephemeral: true });
        return true;
      }
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      await interaction.editReply({ content: `Close canceled for carry #${carryId}.` });
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

    if (["assign", "reassign"].includes(parsed.action) && parsed.carryId !== null) {
      if (!this.isAdmin(interaction.member)) {
        await interaction.reply({ content: "Only Service-Admin can reassign carriers.", ephemeral: true });
        return true;
      }
      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}reassign:${parsed.carryId}`).setTitle("Assign/Reassign Carriers");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("carrier_ids").setLabel("Carrier IDs (comma separated)").setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
      await interaction.showModal(modal);
      return true;
    }

    if (["claim", "unclaim", "close_ticket", "reping", "reopen"].includes(parsed.action) && parsed.carryId !== null) {
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
      if (parsed.action === "unclaim") result = await this.unclaimCarry(parsed.carryId, interaction.user.id, this.isAdmin(interaction.member));
      if (parsed.action === "close_ticket") result = await this.closeCarryTicket(parsed.carryId, interaction.user.id, this.isStaff(interaction.member));
      if (parsed.action === "reping") result = await this.repingCarriers(parsed.carryId, interaction.user.id, this.isStaff(interaction.member));
      if (parsed.action === "reopen") {
        const carry = this.getCarryById(parsed.carryId);
        result = carry?.ticket_id ? await this.reopenCarryForTicket(carry.ticket_id, interaction.user.id) : { ok: false, reason: "No linked ticket found." };
      }

      const doneText = parsed.action === "reping" ? `Reping sent for carry #${parsed.carryId}.` : `Action \`${parsed.action}\` applied on carry #${parsed.carryId}.`;
      await interaction.editReply({ content: result?.ok ? doneText : result?.reason || "Action failed." });
      return true;
    }

    if (["mark_paid", "log_runs"].includes(parsed.action) && parsed.carryId !== null) {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can perform this action.", ephemeral: true });
        return true;
      }

      const modal = new ModalBuilder()
        .setCustomId(`${CARRY_MODAL_PREFIX}${parsed.action}:${parsed.carryId}`)
        .setTitle(parsed.action === "mark_paid" ? "Log Payment" : "Log Runs");
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
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const result = await this.confirmCarryCompletion(parsed.carryId, interaction.user.id);
      await interaction.editReply({ content: result.ok ? `Carry #${parsed.carryId} confirmed. Rating prompt posted.` : result.reason });
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

      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      this.db
        .getConnection()
        .prepare("INSERT INTO customer_ratings (carry_id, customer_discord_id, rating, comment, created_at) VALUES (?, ?, ?, NULL, ?)")
        .run(carryId, interaction.user.id, rating, Date.now());
      this.db.logEvent("carry.rated", "carry", carryId, { customerId: interaction.user.id, rating });
      await this.finalizeCarry(carryId);
      await this.publishCarrierStatsDashboard().catch(() => {});
      await interaction.editReply({ content: `Thanks. You rated carry #${carryId} with ${rating}/5.` });
      return true;
    }

    if (["claim", "start", "complete", "cancel", "mark_paid", "log_runs"].includes(parsed.action) && parsed.carryId === null) {
      if (!this.isCarrier(interaction.member) && !this.isStaff(interaction.member)) {
        await interaction.reply({ content: "Only carriers/staff can perform this action.", ephemeral: true });
        return true;
      }

      const modal = new ModalBuilder().setCustomId(`${CARRY_MODAL_PREFIX}${parsed.action}`).setTitle(`${parsed.action} Carry`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("carry_id").setLabel("Carry ID").setStyle(TextInputStyle.Short).setRequired(true))
      );
      await interaction.showModal(modal);
      return true;
    }

    return false;
  }

  async handleModal(interaction) {
    if (!interaction.customId?.startsWith(CARRY_MODAL_PREFIX)) return false;

    const action = interaction.customId.slice(CARRY_MODAL_PREFIX.length);
    if (action.startsWith("bulk:")) {
      if (!this.isStaff(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only staff can run bulk actions."], ephemeral: true }));
        return true;
      }

      const confirm = String(interaction.fields.getTextInputValue("confirm") || "")
        .trim()
        .toUpperCase();
      if (confirm !== "CONFIRM") {
        await interaction.reply(infoPayload({ title: "Bulk Action Canceled", lines: ["Confirmation phrase did not match."], ephemeral: true }));
        return true;
      }

      const bulkAction = String(action.split(":")[1] || "");
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      if (bulkAction === "claim_next_3") {
        const rows = this.getQueueRows().slice(0, 3);
        let claimed = 0;
        let failed = 0;
        const errorDetails = [];

        for (const row of rows) {
          const result = await this.claimCarry(Number(row.carry_id), interaction.user.id);
          if (result?.ok) {
            claimed += 1;
          } else {
            failed += 1;
            if (errorDetails.length < 10) {
              errorDetails.push(`#${Number(row.carry_id)}: ${result?.reason || "claim failed"}`);
            }
          }
        }

        this.db.logEvent("carry.bulk_claim_next_3", "carry", interaction.user.id, { scanned: rows.length, claimed, failed, errorDetails });
        await interaction.editReply(
          infoPayload({
            title: "Bulk Claim",
            lines: [`Claimed ${claimed}/${rows.length} carries.`, `Failed: ${failed}`, ...(errorDetails.length ? [`Details: ${errorDetails.join(" | ")}`] : [])],
            ephemeral: true
          })
        );
        return true;
      }

      if (bulkAction === "close_completed") {
        const rows = this.db.getConnection().prepare("SELECT id, execution_channel_id FROM carries WHERE status = 'completed' ORDER BY id DESC LIMIT 100").all();
        let closed = 0;
        let failed = 0;
        const errorDetails = [];

        for (const row of rows) {
          if (!row.execution_channel_id) continue;
          const closeResult = await this.closeExecutionChannel(row.execution_channel_id, { immediate: true }).catch((error) => ({
            ok: false,
            reason: error?.message || String(error)
          }));
          if (closeResult?.ok === false) {
            failed += 1;
            if (errorDetails.length < 10) {
              errorDetails.push(`#${Number(row.id)}: ${closeResult?.reason || "close failed"}`);
            }
            continue;
          }
          this.db.getConnection().prepare("UPDATE carries SET execution_channel_id = NULL WHERE id = ?").run(row.id);
          closed += 1;
        }

        this.db.logEvent("carry.bulk_close_completed", "carry", interaction.user.id, { scanned: rows.length, closed, failed, errorDetails });
        await interaction.editReply(
          infoPayload({
            title: "Bulk Close",
            lines: [
              `Scanned ${rows.length} completed carries.`,
              `Closed lingering channels: ${closed}`,
              `Failed: ${failed}`,
              ...(errorDetails.length ? [`Details: ${errorDetails.join(" | ")}`] : [])
            ],
            ephemeral: true
          })
        );
        return true;
      }

      await interaction.editReply(infoPayload({ title: "Bulk Action", lines: ["Unknown bulk action."], ephemeral: true }));
      return true;
    }

    if (action.startsWith("jump:")) {
      const scope = String(action.split(":")[1] || "carry_dashboard");
      const page = Math.max(1, Number(interaction.fields.getTextInputValue("page")));
      const messageId = interaction.message?.id || this.db.getBinding("carry_dashboard_message_id", "0");
      const actorId = interaction.user?.id || "0";
      const current = this.getPanelState(scope, messageId, actorId);
      this.setPanelState(scope, messageId, actorId, { viewKey: current.viewKey, page, expanded: current.expanded });

      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      if (scope === "carry_dashboard") await this.publishCarryDashboard(null, { viewKey: current.viewKey, page });
      if (scope === "carrier_dashboard") await this.publishCarrierDashboard(null, { page });
      if (scope === "stats_dashboard") await this.publishCarrierStatsDashboard(null, { page });
      await interaction.editReply(infoPayload({ title: "Jump Applied", lines: [`Moved to page ${page}.`], ephemeral: true }));
      return true;
    }

    if (action.startsWith("admin_reassign:") || action.startsWith("reassign:")) {
      if (!this.isAdmin(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only Service-Admin can reassign carriers."], ephemeral: true }));
        return true;
      }
      const carryId = Number(action.split(":")[1]);
      const value = String(interaction.fields.getTextInputValue("carrier_ids") || "").trim();
      const ids = value
        .split(",")
        .map((part) => part.trim())
        .filter((id) => /^\d{17,20}$/.test(id));
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const carry = this.getCarryById(carryId);
      if (!carry) {
        await interaction.editReply(infoPayload({ title: "Reassign Failed", lines: ["Carry not found."], ephemeral: true }));
        return true;
      }
      this.db.getConnection().prepare("UPDATE carries SET assigned_carrier_discord_ids = ? WHERE id = ?").run(JSON.stringify(ids), carryId);
      if (carry.execution_channel_id) {
        await this.ensureExecutionChannelAccess(carry.execution_channel_id, carry, ids).catch(() => {});
      }
      this.db.logEvent("carry.reassigned", "carry", carryId, { actorId: interaction.user.id, ids });
      await this.refreshExecutionPanel(carryId).catch(() => {});
      await interaction.editReply(infoPayload({ title: "Reassigned", lines: [`Updated carriers for carry #${carryId}.`], ephemeral: true }));
      return true;
    }

    if (action.startsWith("mark_paid:")) {
      const carryId = Number(action.split(":")[1]);
      const amountRaw = interaction.fields.getTextInputValue("paid_amount");
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const result = await this.markPaid(carryId, interaction.user.id, amountRaw);
      if (!result.ok) {
        await interaction.editReply({ content: result.reason });
        return true;
      }
      const c = result.coverage;
      await interaction.editReply({
        content: `Logged payment for carry #${carryId}. Paid: ${this.formatCoinsShort(c.paidAmount)} | Covers: ${c.coveredRuns}/${c.amount} | Remaining: ${this.formatCoinsShort(c.remainingPayment)}`
      });
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
      await interaction.editReply(
        panelPayload(
          makePanel({
            title: `Carry Request #${created.carryId}`,
            status: "Queued",
            sections: [
              {
                title: "Pricing",
                lines: [
                  `- Base Price: **${this.formatCoinsShort(breakdown.baseTotal)}**`,
                  `- Discount: **${this.formatCoinsShort(created.totalDiscount)}**`,
                  `- Final: **${this.formatCoinsShort(created.finalPrice)}**`,
                  `- ETA: **~${mins} min**`,
                  `- Free Carry: **${
                    created.freeEligible
                      ? `Applied (${created.freeSource || "weekly"})`
                      : created.freeBlockedByType
                        ? "Not available for Kuudra/M7"
                        : created.freeBlockedByVerification
                          ? "Requires verified account"
                          : "Not available"
                  }**`
                ]
              }
            ],
            accentColor: 0x57f287
          })
        )
      );

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

    const message = result?.ok
      ? action === "start" && result.channelId
        ? `Carry #${carryId} started in <#${result.channelId}>.`
        : `Action \`${action}\` applied on carry #${carryId}.`
      : result?.reason || "Action failed.";

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
      .run(
        rule.kind,
        rule.scope,
        rule.category || null,
        rule.carryType || null,
        rule.tier || null,
        rule.minAmount ?? null,
        Number(rule.percentage),
        rule.startsAt ?? null,
        rule.endsAt ?? null,
        now
      );

    return Number(result.lastInsertRowid);
  }

  removeStaticDiscountByAmount(amount) {
    return this.db.getConnection().prepare("DELETE FROM discount_rules WHERE kind = 'static' AND scope = 'global' AND min_amount = ?").run(Number(amount)).changes;
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
