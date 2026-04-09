const {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const ms = require("ms");
const { actionButton, infoPayload, makePanel, panelPayload } = require("./componentsV2Panels.js");

const SETUP_PREFIX = "carrysetup:";
const SETUP_MODAL_PREFIX = "carrysetup:modal:";
const SETUP_SCOPE = "carry_setup";
const VIEWS = ["overview", "channels", "prices", "queue", "discounts"];

class CarrySetupService {
  constructor({ db, carryService, ticketService }) {
    this.db = db;
    this.carryService = carryService;
    this.ticketService = ticketService;
    this.client = null;
  }

  initialize(client) {
    this.client = client;
  }

  parseExpanded(expanded = []) {
    const out = { setting: "carry_dashboard", category: "dungeons", type: "dungeons", tier: "f1" };
    for (const token of expanded) {
      const [k, v] = String(token || "").split(":");
      if (!k || !v) continue;
      if (k === "setting") out.setting = v;
      if (k === "category") out.category = v;
      if (k === "type") out.type = v;
      if (k === "tier") out.tier = v;
    }
    return out;
  }

  toExpanded(meta) {
    return [`setting:${meta.setting}`, `category:${meta.category}`, `type:${meta.type}`, `tier:${meta.tier}`];
  }

  getState(messageId, actorId) {
    const raw = this.db.getUiPanelState({
      panelScope: SETUP_SCOPE,
      messageId: String(messageId || "0"),
      actorId: String(actorId || "0"),
      fallback: { viewKey: "overview", page: 1, expanded: [] }
    }) || { viewKey: "overview", page: 1, expanded: [] };
    return { viewKey: VIEWS.includes(String(raw.viewKey || "")) ? String(raw.viewKey) : "overview", meta: this.parseExpanded(raw.expanded) };
  }

  setState(messageId, actorId, { viewKey, meta }) {
    this.db.setUiPanelState({
      panelScope: SETUP_SCOPE,
      messageId: String(messageId || "0"),
      actorId: String(actorId || "0"),
      viewKey: VIEWS.includes(String(viewKey || "")) ? String(viewKey) : "overview",
      page: 1,
      expanded: this.toExpanded(meta)
    });
  }

  formatCoinsShort(value) {
    const num = Number(value || 0);
    const abs = Math.abs(num);
    if (abs >= 1e9) return `${(num / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}b`;
    if (abs >= 1e6) return `${(num / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}m`;
    if (abs >= 1e3) return `${(num / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
    return `${Math.round(num)}`;
  }

  getCatalogTree() {
    const rows = this.db
      .getConnection()
      .prepare("SELECT carry_type, tier, category, price, enabled FROM carry_catalog WHERE lower(tier) NOT IN ('5','t5') ORDER BY category, carry_type, tier")
      .all();
    const categories = [...new Set(rows.map((r) => String(r.category || "other")))];
    const byCategory = new Map();
    for (const row of rows) {
      const key = String(row.category || "other");
      const list = byCategory.get(key) || [];
      list.push(row);
      byCategory.set(key, list);
    }
    return { rows, categories, byCategory };
  }

  viewOptions() {
    return [
      { value: "overview", label: "Overview", description: "System status" },
      { value: "channels", label: "Channels", description: "Dashboard/forum/category mappings" },
      { value: "prices", label: "Prices", description: "Category, type, tier pricing" },
      { value: "queue", label: "Queue", description: "Queue and operational settings" },
      { value: "discounts", label: "Discounts", description: "Discount policy and rules" }
    ];
  }

  settingOptions() {
    return [
      { value: "carry_dashboard", label: "Carry Dashboard Channel" },
      { value: "carrier_dashboard", label: "Carrier Dashboard Channel" },
      { value: "carrier_stats", label: "Carrier Stats Channel" },
      { value: "ticket_dashboard", label: "Ticket Dashboard Channel" },
      { value: "ticket_logs_forum", label: "Ticket Logs Forum" },
      { value: "carry_category", label: "Carry Category" }
    ];
  }

  channelTypesForSetting(setting) {
    if (["carry_dashboard", "carrier_dashboard", "carrier_stats", "ticket_dashboard"].includes(setting)) return [ChannelType.GuildText, ChannelType.GuildAnnouncement];
    if (setting === "ticket_logs_forum") return [ChannelType.GuildForum];
    if (setting === "carry_category") return [ChannelType.GuildCategory];
    return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory];
  }

  getCurrentValueLabel(setting) {
    if (setting === "carry_dashboard") return this.carryService.getCarryDashboardChannelId() || "not set";
    if (setting === "carrier_dashboard") return this.carryService.getCarrierDashboardChannelId() || "not set";
    if (setting === "carrier_stats") return this.carryService.getCarrierStatsChannelId() || "not set";
    if (setting === "ticket_dashboard") return this.ticketService.getTicketDashboardChannelId() || "not set";
    if (setting === "ticket_logs_forum") return this.ticketService.getTicketLogsForumId() || "not set";
    if (setting === "carry_category") return this.carryService.getCarryCategoryId() || "not set";
    return "not set";
  }

  withFallbackOptions(options, fallbackLabel = "No options available") {
    if (Array.isArray(options) && options.length > 0) return options;
    return [{ label: fallbackLabel, value: "__none__", default: true }];
  }

  chunk(items, size = 5) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  canManageSetup(member) {
    if (this.carryService?.isStaff?.(member)) return true;
    if (member?.permissions?.has) {
      if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
      if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
    }
    return false;
  }

  buildSetupPanel({ messageId, actorId, guild = null }) {
    const state = this.getState(messageId, actorId);
    const { viewKey, meta } = state;
    const { byCategory, categories } = this.getCatalogTree();

    const sections = [];

    const topRows = [
      new ActionRowBuilder().addComponents(
        actionButton(`${SETUP_PREFIX}view:overview`, "Overview", viewKey === "overview" ? 1 : 2, { disabled: viewKey === "overview" }),
        actionButton(`${SETUP_PREFIX}view:channels`, "Channels", viewKey === "channels" ? 1 : 2, { disabled: viewKey === "channels" }),
        actionButton(`${SETUP_PREFIX}view:prices`, "Prices", viewKey === "prices" ? 1 : 2, { disabled: viewKey === "prices" }),
        actionButton(`${SETUP_PREFIX}view:queue`, "Queue", viewKey === "queue" ? 1 : 2, { disabled: viewKey === "queue" }),
        actionButton(`${SETUP_PREFIX}view:discounts`, "Discounts", viewKey === "discounts" ? 1 : 2, { disabled: viewKey === "discounts" })
      )
    ];
    const actions = [actionButton(`${SETUP_PREFIX}refresh`, "Refresh", 2)];
    const extraRows = [];

    if (viewKey === "overview") {
      sections.push({
        title: "Carry / Ticket Setup",
        lines: [
          "Use the category buttons above to configure each area.",
          `- Ticket Dashboard: ${this.ticketService.getTicketDashboardChannelId() ? `<#${this.ticketService.getTicketDashboardChannelId()}>` : "not set"}`,
          `- Carry Dashboard: ${this.carryService.getCarryDashboardChannelId() ? `<#${this.carryService.getCarryDashboardChannelId()}>` : "not set"}`,
          `- Carry Category: ${this.carryService.getCarryCategoryId() ? `<#${this.carryService.getCarryCategoryId()}>` : "not set"}`,
          `- Service-Team Role: ${this.carryService.getServiceTeamRoleId() ? `<@&${this.carryService.getServiceTeamRoleId()}>` : "not set"}`,
          `- Service-Admin Role: ${this.carryService.getServiceAdminRoleId() ? `<@&${this.carryService.getServiceAdminRoleId()}>` : "not set"}`
        ]
      });
    }

    if (viewKey === "channels") {
      sections.push({
        title: "Channels",
        lines: [
          `- Selected Setting: **${meta.setting}**`,
          `- Current Value: **${this.getCurrentValueLabel(meta.setting)}**`,
          "- Flow: select setting above -> select channel above."
        ]
      });
      topRows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`${SETUP_PREFIX}setting_select`)
            .setPlaceholder("1) Choose setting")
            .addOptions(
              this.withFallbackOptions(
                this.settingOptions().map((o) => ({ label: o.label, value: o.value, default: o.value === meta.setting })),
                "No settings"
              )
            )
        ),
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`${SETUP_PREFIX}channel_pick`)
            .setPlaceholder("2) Pick channel")
            .setChannelTypes(this.channelTypesForSetting(meta.setting))
        )
      );
      actions.push(actionButton(`${SETUP_PREFIX}publish_dashboards`, "Republish Dashboards", 2));
    }

    if (viewKey === "prices") {
      const categoryRows = byCategory.get(meta.category) || [];
      const typeOptions = [...new Set(categoryRows.map((r) => String(r.carry_type)))];
      if (typeOptions.length > 0 && !typeOptions.includes(meta.type)) {
        meta.type = typeOptions[0];
      }
      const tierRows = categoryRows
        .filter((r) => String(r.carry_type) === String(meta.type))
        .map((r) => ({ type: String(r.carry_type), tier: String(r.tier), price: Number(r.price || 0), enabled: Number(r.enabled || 0) === 1 }));
      const selectedTierRow = tierRows.find((r) => r.tier === meta.tier) || tierRows[0] || null;
      if (selectedTierRow) {
        meta.type = selectedTierRow.type;
        meta.tier = selectedTierRow.tier;
      }
      sections.push({
        title: "Prices",
        lines: [
          `- Category: **${meta.category}** | Type: **${meta.type}** | Tier: **${meta.tier}**`,
          `- Current Price: **${selectedTierRow ? this.formatCoinsShort(selectedTierRow.price) : "n/a"}**`,
          `- Enabled: **${selectedTierRow ? (selectedTierRow.enabled ? "Yes" : "No") : "n/a"}**`,
          "- Select a tier button, then set price."
        ]
      });
      topRows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`${SETUP_PREFIX}price_category`)
            .setPlaceholder("Choose category")
            .addOptions(
              this.withFallbackOptions(
                categories.slice(0, 25).map((c) => ({ label: c, value: c, default: c === meta.category })),
                "No categories"
              )
            )
        )
      );
      if (typeOptions.length > 1) {
        topRows.push(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`${SETUP_PREFIX}price_type`)
              .setPlaceholder("Choose type")
              .addOptions(
                this.withFallbackOptions(
                  typeOptions.slice(0, 25).map((type) => ({ label: type, value: type, default: type === meta.type })),
                  "No types"
                )
              )
          )
        );
      }
      const groupRows = (label, list) => {
        if (!list.length) return;
        sections.push({ title: label, lines: [`- ${list.map((r) => r.tier.toUpperCase()).join(", ")}`] });
        for (const group of this.chunk(list, 5)) {
          extraRows.push(
            new ActionRowBuilder().addComponents(
              ...group.map((r) => actionButton(`${SETUP_PREFIX}quick_price:${r.type}:${r.tier}`, r.tier.toLowerCase(), r.tier === meta.tier ? 1 : 2))
            )
          );
        }
      };
      const isTier = (row, re) => re.test(String(row.tier || "").toLowerCase());
      if (String(meta.category).toLowerCase() === "dungeons") {
        groupRows(
          "F1 - F5",
          tierRows.filter((r) => isTier(r, /^f[1-5]$/i))
        );
        groupRows(
          "F6 - F7",
          tierRows.filter((r) => isTier(r, /^f[67]$/i))
        );
        groupRows(
          "M1 - M5",
          tierRows.filter((r) => isTier(r, /^m[1-5]$/i))
        );
        groupRows(
          "M6 - M7",
          tierRows.filter((r) => isTier(r, /^m[67]$/i))
        );
        const used = new Set(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
        groupRows(
          "Other Tiers",
          tierRows.filter((r) => !used.has(String(r.tier).toLowerCase()))
        );
      } else {
        groupRows("Tiers", tierRows);
      }
      actions.push(actionButton(`${SETUP_PREFIX}price_set`, "Set Price", 1));
    }

    if (viewKey === "queue") {
      const queueEnabled = this.carryService.isQueueEnabled();
      const transcriptEnabled = this.carryService.isCarryTranscriptEnabled();
      sections.push({
        title: "Queue & Operations",
        lines: [
          `- Queue Enabled: **${queueEnabled ? "Yes" : "No"}**`,
          `- Transcript Logging: **${transcriptEnabled ? "Yes" : "No"}**`,
          `- Auto Delete: **${ms(this.carryService.getCarryAutoDeleteMs())}**`,
          `- Free Carry Limit: **${this.carryService.getFreeCarryLimit()}**`,
          `- Service-Team Role: **${this.carryService.getServiceTeamRoleId() ? `<@&${this.carryService.getServiceTeamRoleId()}>` : "not set"}**`,
          `- Service-Admin Role: **${this.carryService.getServiceAdminRoleId() ? `<@&${this.carryService.getServiceAdminRoleId()}>` : "not set"}**`
        ]
      });
      actions.push(
        actionButton(`${SETUP_PREFIX}set_service_team_role`, "Service-Team", 1),
        actionButton(`${SETUP_PREFIX}set_service_admin_role`, "Service-Admin", 1),
        actionButton(`${SETUP_PREFIX}set_autodelete`, "AutoDelete", 1),
        actionButton(`${SETUP_PREFIX}set_free_limit`, "Free Limit", 1),
        actionButton(`${SETUP_PREFIX}set_role_priority`, "Role Priority", 1),
        actionButton(`${SETUP_PREFIX}toggle_transcript`, transcriptEnabled ? "Transcript On" : "Transcript Off", transcriptEnabled ? 3 : 4),
        actionButton(`${SETUP_PREFIX}queue_toggle`, queueEnabled ? "Queue On" : "Queue Off", queueEnabled ? 3 : 4),
        actionButton(`${SETUP_PREFIX}queue_reset`, "Queue Reset", 4)
      );
    }

    if (viewKey === "discounts") {
      const activeRules = this.db
        .getConnection()
        .prepare("SELECT id, kind, scope, category, carry_type, tier, min_amount, percentage, ends_at FROM discount_rules WHERE active = 1 ORDER BY id DESC LIMIT 8")
        .all();
      const stacking = Boolean(this.db.getBinding("discount_stacking_enabled", false));
      sections.push({
        title: "Discount Rules",
        lines: [
          `- Stacking: **${stacking ? "Enabled" : "Disabled"}**`,
          ...(activeRules.length
            ? activeRules.map(
                (r) =>
                  `- #${r.id} ${r.kind}/${r.scope} ${r.carry_type || r.category || "global"} ${r.tier || ""} ${r.min_amount ? `min ${r.min_amount}` : ""} ${Number(r.percentage || 0)}%${r.ends_at ? ` (ends <t:${Math.floor(Number(r.ends_at) / 1000)}:R>)` : ""}`
              )
            : ["- No active rules"])
        ]
      });
      actions.push(
        actionButton(`${SETUP_PREFIX}discount_static_add`, "Add Static", 1),
        actionButton(`${SETUP_PREFIX}discount_static_remove`, "Remove Static", 4),
        actionButton(`${SETUP_PREFIX}discount_timed_global`, "Timed Global", 1),
        actionButton(`${SETUP_PREFIX}discount_toggle_stacking`, "Toggle Stacking", 2)
      );
    }

    if (viewKey === "overview") actions.push(actionButton(`${SETUP_PREFIX}publish_dashboards`, "Republish Dashboards", 2));

    return panelPayload(
      makePanel({
        title: "Carry / Ticket Setup Dashboard",
        status: `View: ${viewKey}`,
        sections,
        topRows,
        actions,
        extraRows,
        accentColor: 0x5865f2,
        footer: "Interactive setup panel - Components V2"
      })
    );
  }

  async show(interaction) {
    const messageId = interaction.id || "0";
    const actorId = interaction.user?.id || "0";
    const state = this.getState(messageId, actorId);
    this.setState(messageId, actorId, state);
    const sent = await interaction.editReply(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
    if (sent?.id) {
      this.db.setBinding("carry_setup_message_id", sent.id);
      this.setState(sent.id, actorId, state);
    }
    return sent;
  }

  async applySettingChannel(guild, settingKey, channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return { ok: false, reason: "Channel not found." };
    if (settingKey === "carry_dashboard") {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
        return { ok: false, reason: "Carry dashboard requires text/announcement channel." };
      this.carryService.setCarryDashboardChannelId(channel.id);
      await this.carryService.publishCarryDashboard(channel.id).catch(() => {});
      return { ok: true };
    }
    if (settingKey === "carrier_dashboard") {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
        return { ok: false, reason: "Carrier dashboard requires text/announcement channel." };
      this.carryService.setCarrierDashboardChannelId(channel.id);
      await this.carryService.publishCarrierDashboard(channel.id).catch(() => {});
      return { ok: true };
    }
    if (settingKey === "carrier_stats") {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
        return { ok: false, reason: "Carrier stats requires text/announcement channel." };
      this.carryService.setCarrierStatsChannelId(channel.id);
      await this.carryService.publishCarrierStatsDashboard(channel.id).catch(() => {});
      return { ok: true };
    }
    if (settingKey === "ticket_dashboard") {
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
        return { ok: false, reason: "Ticket dashboard requires text/announcement channel." };
      this.ticketService.setTicketDashboardChannelId(channel.id);
      await this.ticketService.publishDashboard(channel.id).catch(() => {});
      return { ok: true };
    }
    if (settingKey === "ticket_logs_forum") {
      if (channel.type !== ChannelType.GuildForum) return { ok: false, reason: "Ticket logs must be a forum channel." };
      this.ticketService.setTicketLogsForumId(channel.id);
      return { ok: true };
    }
    if (settingKey === "carry_category") {
      if (channel.type !== ChannelType.GuildCategory) return { ok: false, reason: "Carry category must be a category channel." };
      this.carryService.setCarryCategoryId(channel.id);
      return { ok: true };
    }
    return { ok: false, reason: "Unknown setting key." };
  }

  async handleComponent(interaction) {
    if (!String(interaction.customId || "").startsWith(SETUP_PREFIX)) return false;
    try {
      if (!this.canManageSetup(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only staff/admin can use this setup panel."], ephemeral: true })).catch(() => {});
        return true;
      }
      const actorId = interaction.user?.id || "0";
      const messageId = interaction.message?.id || this.db.getBinding("carry_setup_message_id", "0");
      const state = this.getState(messageId, actorId);
      const payload = String(interaction.customId).slice(SETUP_PREFIX.length);

      if (payload === "view_select" || payload.startsWith("view:")) {
        const viewKey = payload === "view_select" ? String(interaction.values?.[0] || "overview") : String(payload.split(":")[1] || "overview");
        state.viewKey = VIEWS.includes(viewKey) ? viewKey : "overview";
        this.setState(messageId, actorId, state);
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "refresh") {
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "setting_select") {
        const next = String(interaction.values?.[0] || state.meta.setting);
        if (next !== "__none__") state.meta.setting = next;
        this.setState(messageId, actorId, state);
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "channel_pick") {
        const channelId = String(interaction.values?.[0] || "");
        const result = await this.applySettingChannel(interaction.guild, state.meta.setting, channelId);
        if (!result.ok) {
          await interaction.reply(infoPayload({ title: "Setup Update Failed", lines: [result.reason], ephemeral: true }));
          return true;
        }
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "price_category" || payload === "price_type" || payload === "price_tier") {
        const value = String(interaction.values?.[0] || "");
        if (payload === "price_category" && value !== "__none__") {
          state.meta.category = value;
          const row = this.db
            .getConnection()
            .prepare("SELECT carry_type, tier FROM carry_catalog WHERE category = ? AND lower(tier) NOT IN ('5','t5') ORDER BY carry_type, tier LIMIT 1")
            .get(value);
          if (row) {
            state.meta.type = String(row.carry_type);
            state.meta.tier = String(row.tier);
          }
        }
        if (payload === "price_type" && value !== "__none__") state.meta.type = value;
        if (payload === "price_tier" && value !== "__none__") state.meta.tier = value;
        this.setState(messageId, actorId, state);
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "price_set") {
        const modal = new ModalBuilder().setCustomId(`${SETUP_MODAL_PREFIX}price:${messageId}`).setTitle("Set Carry Price");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("price")
              .setLabel(`Price for ${state.meta.type} ${state.meta.tier}`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder("e.g. 400k, 1.5m")
          )
        );
        await interaction.showModal(modal);
        return true;
      }
      if (payload.startsWith("quick_price:")) {
        const [, type, tier] = payload.split(":");
        const modal = new ModalBuilder().setCustomId(`${SETUP_MODAL_PREFIX}pricequick:${messageId}:${type}:${tier}`).setTitle(`Set Price: ${type} ${tier}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("price").setLabel("Price (e.g. 400k, 1.5m)").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return true;
      }
      if (payload === "price_enable_type" || payload === "price_disable_type") {
        const changes = this.carryService.setCarryEnabled(state.meta.type, payload === "price_enable_type");
        await this.carryService.publishCarryDashboard().catch(() => {});
        await interaction.reply(infoPayload({ title: "Catalog Updated", lines: [`Changed ${changes} rows for ${state.meta.type}.`], ephemeral: true }));
        return true;
      }
      if (payload === "publish_dashboards") {
        await this.carryService.publishCarryDashboard().catch(() => {});
        await this.carryService.publishCarrierDashboard().catch(() => {});
        await this.carryService.publishCarrierStatsDashboard().catch(() => {});
        await this.ticketService.publishDashboard().catch(() => {});
        await interaction.reply(infoPayload({ title: "Dashboards", lines: ["Republished carry/ticket dashboards."], ephemeral: true }));
        return true;
      }
      if (payload === "toggle_transcript") {
        this.carryService.setCarryTranscriptEnabled(!this.carryService.isCarryTranscriptEnabled());
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "queue_enable" || payload === "queue_disable" || payload === "queue_toggle") {
        const next = payload === "queue_enable" ? true : payload === "queue_disable" ? false : !this.carryService.isQueueEnabled();
        this.carryService.setQueueEnabled(next);
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (payload === "queue_reset") {
        this.carryService.resetQueue();
        await this.carryService.publishCarrierDashboard().catch(() => {});
        await interaction.reply(infoPayload({ title: "Queue", lines: ["Queue reset complete."], ephemeral: true }));
        return true;
      }
      if (payload === "discount_toggle_stacking") {
        this.db.setBinding("discount_stacking_enabled", !this.db.getBinding("discount_stacking_enabled", false));
        await interaction.update(this.buildSetupPanel({ messageId, actorId, guild: interaction.guild }));
        return true;
      }
      if (
        [
          "set_autodelete",
          "set_service_team_role",
          "set_service_admin_role",
          "set_free_limit",
          "set_role_priority",
          "discount_static_add",
          "discount_static_remove",
          "discount_timed_global"
        ].includes(payload)
      ) {
        const modal = new ModalBuilder().setCustomId(`${SETUP_MODAL_PREFIX}${payload}:${messageId}`).setTitle(payload);
        const add = (id, label) =>
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true));
        if (payload === "set_role_priority") modal.addComponents(add("role", "Role ID or mention"), add("value", "Priority value"));
        else if (payload === "discount_static_add") modal.addComponents(add("amount", "Min Amount"), add("percentage", "Percentage (0-95)"));
        else if (payload === "discount_static_remove") modal.addComponents(add("amount", "Min Amount"));
        else if (payload === "discount_timed_global") modal.addComponents(add("percentage", "Percentage (0-95)"), add("duration", "Duration (e.g. 3h)"));
        else
          modal.addComponents(
            add(
              "value",
              payload === "set_autodelete"
                ? "Duration (e.g. 30m)"
                : ["set_service_team_role", "set_service_admin_role"].includes(payload)
                  ? "Role ID or mention"
                  : "Weekly limit"
            )
          );
        await interaction.showModal(modal);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`carry-setup component error: ${error?.stack || error?.message || String(error)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(infoPayload({ title: "Setup Error", lines: ["Action failed. Please try again."], ephemeral: true })).catch(() => {});
      }
      return true;
    }
  }

  async handleModal(interaction) {
    if (!String(interaction.customId || "").startsWith(SETUP_MODAL_PREFIX)) return false;
    try {
      if (!this.canManageSetup(interaction.member)) {
        await interaction.reply(infoPayload({ title: "Not Allowed", lines: ["Only staff/admin can submit setup changes."], ephemeral: true })).catch(() => {});
        return true;
      }
      const payload = String(interaction.customId).slice(SETUP_MODAL_PREFIX.length);
      const parts = payload.split(":");
      const action = String(parts[0] || "");
      const messageId = String(parts[1] || "0");
      const actorId = interaction.user?.id || "0";
      const state = this.getState(messageId, actorId);

      if (action === "price") {
        const parsed = this.carryService.parseCoinsInput(String(interaction.fields.getTextInputValue("price") || "").trim());
        if (!Number.isFinite(parsed) || parsed < 0) {
          await interaction.reply(infoPayload({ title: "Invalid Price", lines: ["Use values like 400k or 1.5m."], ephemeral: true }));
          return true;
        }
        const updated = this.carryService.setCarryPrice(state.meta.type, state.meta.tier, parsed);
        await this.carryService.publishCarryDashboard().catch(() => {});
        await interaction.reply(
          infoPayload({
            title: "Price Updated",
            lines: [updated ? `Set ${state.meta.type} ${state.meta.tier} to ${this.formatCoinsShort(parsed)}.` : "No matching carry type/tier found."],
            ephemeral: true
          })
        );
        return true;
      }
      if (action === "pricequick") {
        const type = String(parts[2] || "");
        const tier = String(parts[3] || "");
        const parsed = this.carryService.parseCoinsInput(String(interaction.fields.getTextInputValue("price") || "").trim());
        if (!Number.isFinite(parsed) || parsed < 0) {
          await interaction.reply(infoPayload({ title: "Invalid Price", lines: ["Use values like 400k or 1.5m."], ephemeral: true }));
          return true;
        }
        const updated = this.carryService.setCarryPrice(type, tier, parsed);
        await this.carryService.publishCarryDashboard().catch(() => {});
        await interaction.reply(
          infoPayload({
            title: "Price Updated",
            lines: [updated ? `Set ${type} ${tier} to ${this.formatCoinsShort(parsed)}.` : "No matching carry type/tier found."],
            ephemeral: true
          })
        );
        return true;
      }

      if (action === "set_autodelete") {
        const parsed = ms(String(interaction.fields.getTextInputValue("value") || "").trim());
        if (!parsed || parsed <= 0) return interaction.reply(infoPayload({ title: "Invalid Duration", lines: ["Use values like 30m or 2h."], ephemeral: true }));
        this.carryService.setCarryAutoDelete(parsed);
        await interaction.reply(infoPayload({ title: "AutoDelete Updated", lines: [`New delay: ${ms(parsed)}`], ephemeral: true }));
        return true;
      }

      if (action === "set_service_team_role") {
        const roleId = String(interaction.fields.getTextInputValue("value") || "")
          .trim()
          .replace(/[<@&>]/g, "");
        if (!/^\d{17,20}$/.test(roleId)) return interaction.reply(infoPayload({ title: "Invalid Role", lines: ["Provide a role mention or role id."], ephemeral: true }));
        this.carryService.setServiceTeamRoleId(roleId);
        await interaction.reply(infoPayload({ title: "Role Updated", lines: [`Service-Team role set to <@&${roleId}>.`], ephemeral: true }));
        return true;
      }

      if (action === "set_service_admin_role") {
        const roleId = String(interaction.fields.getTextInputValue("value") || "")
          .trim()
          .replace(/[<@&>]/g, "");
        if (!/^\d{17,20}$/.test(roleId)) return interaction.reply(infoPayload({ title: "Invalid Role", lines: ["Provide a role mention or role id."], ephemeral: true }));
        this.carryService.setServiceAdminRoleId(roleId);
        await interaction.reply(infoPayload({ title: "Role Updated", lines: [`Service-Admin role set to <@&${roleId}>.`], ephemeral: true }));
        return true;
      }

      if (action === "set_free_limit") {
        const amount = Number(interaction.fields.getTextInputValue("value"));
        if (!Number.isInteger(amount) || amount < 0 || amount > 100)
          return interaction.reply(infoPayload({ title: "Invalid Limit", lines: ["Use a whole number between 0 and 100."], ephemeral: true }));
        this.carryService.setFreeCarryLimit(amount);
        await interaction.reply(infoPayload({ title: "Free Carry Updated", lines: [`Weekly limit set to ${amount}.`], ephemeral: true }));
        return true;
      }

      if (action === "set_role_priority") {
        const roleId = String(interaction.fields.getTextInputValue("role") || "")
          .trim()
          .replace(/[<@&>]/g, "");
        const value = Number(interaction.fields.getTextInputValue("value"));
        if (!/^\d{17,20}$/.test(roleId) || !Number.isFinite(value))
          return interaction.reply(infoPayload({ title: "Invalid Input", lines: ["Provide valid role and numeric value."], ephemeral: true }));
        this.carryService.setRolePriority(roleId, value);
        await interaction.reply(infoPayload({ title: "Priority Updated", lines: [`Role <@&${roleId}> set to ${value}.`], ephemeral: true }));
        return true;
      }

      if (action === "discount_static_add") {
        const amount = Number(interaction.fields.getTextInputValue("amount"));
        const percentage = Number(interaction.fields.getTextInputValue("percentage"));
        if (!Number.isInteger(amount) || amount < 1 || !Number.isFinite(percentage) || percentage < 0 || percentage > 95)
          return interaction.reply(infoPayload({ title: "Invalid Discount", lines: ["Amount >= 1 and percentage 0-95 required."], ephemeral: true }));
        const id = this.carryService.addDiscountRule({ kind: "static", scope: "global", minAmount: amount, percentage });
        await interaction.reply(infoPayload({ title: "Discount Added", lines: [`Created static discount #${id}.`], ephemeral: true }));
        return true;
      }

      if (action === "discount_static_remove") {
        const amount = Number(interaction.fields.getTextInputValue("amount"));
        if (!Number.isInteger(amount) || amount < 1) return interaction.reply(infoPayload({ title: "Invalid Amount", lines: ["Amount must be >= 1."], ephemeral: true }));
        const changes = this.carryService.removeStaticDiscountByAmount(amount);
        await interaction.reply(infoPayload({ title: "Discount Removed", lines: [`Removed ${changes} rule(s).`], ephemeral: true }));
        return true;
      }

      if (action === "discount_timed_global") {
        const percentage = Number(interaction.fields.getTextInputValue("percentage"));
        const durationMs = ms(String(interaction.fields.getTextInputValue("duration") || "").trim());
        if (!Number.isFinite(percentage) || percentage < 0 || percentage > 95 || !durationMs || durationMs <= 0)
          return interaction.reply(infoPayload({ title: "Invalid Timed Discount", lines: ["Percentage 0-95 and valid duration required."], ephemeral: true }));
        const now = Date.now();
        const id = this.carryService.addDiscountRule({ kind: "timed", scope: "global", percentage, startsAt: now, endsAt: now + durationMs });
        await interaction.reply(infoPayload({ title: "Timed Discount Added", lines: [`Created timed discount #${id}.`], ephemeral: true }));
        return true;
      }

      return false;
    } catch (error) {
      console.error(`carry-setup modal error: ${error?.stack || error?.message || String(error)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(infoPayload({ title: "Setup Error", lines: ["Modal action failed. Please try again."], ephemeral: true })).catch(() => {});
      }
      return true;
    }
  }
}

module.exports = { CarrySetupService, SETUP_PREFIX, SETUP_MODAL_PREFIX };
