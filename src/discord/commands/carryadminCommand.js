const { ChannelType, SlashCommandBuilder } = require("discord.js");
const ms = require("ms");
const { makePanel, panelPayload } = require("../other/componentsV2Panels.js");

function successPayload(message, title = "Carry Admin") {
  return panelPayload(
    makePanel({
      title,
      status: "Success",
      sections: [{ title: "Details", lines: [String(message || "Done.")] }],
      accentColor: 0x57f287
    })
  );
}

function errorPayload(message, title = "Carry Admin") {
  return panelPayload(
    makePanel({
      title,
      status: "Error",
      sections: [{ title: "Details", lines: [String(message || "Failed.")] }],
      accentColor: 0xed4245
    })
  );
}

function parseDuration(input) {
  const parsed = ms(input);
  return parsed && parsed > 0 ? parsed : null;
}

function isBlazeT5(type, tier) {
  return String(type || "").toLowerCase() === "slayer_blaze" && ["5", "t5"].includes(String(tier || "").toLowerCase());
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("carryadmin")
    .setDescription("Unified carry/ticket admin controls")
    .addSubcommandGroup((g) =>
      g
        .setName("setup")
        .setDescription("Dashboard and channel setup")
        .addSubcommand((s) =>
          s
            .setName("carry-dashboard")
            .setDescription("Set carry request dashboard channel")
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("carrier-dashboard")
            .setDescription("Set carrier dashboard channel")
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("carrier-stats")
            .setDescription("Set carrier stats channel")
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("ticket-dashboard")
            .setDescription("Set ticket dashboard channel")
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Target channel").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("ticket-logs")
            .setDescription("Set ticket log forum channel")
            .addChannelOption((o) => o.setName("forum_channel").setDescription("Forum channel").setRequired(true).addChannelTypes(ChannelType.GuildForum))
        )
        .addSubcommand((s) =>
          s
            .setName("carry-category")
            .setDescription("Set carry execution category")
            .addChannelOption((o) => o.setName("category").setDescription("Category").setRequired(true).addChannelTypes(ChannelType.GuildCategory))
        )
        .addSubcommand((s) =>
          s
            .setName("carry-autodelete")
            .setDescription("Set carry channel autodelete delay")
            .addStringOption((o) => o.setName("time").setDescription("e.g. 30m, 2h").setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName("carry-transcript")
            .setDescription("Enable/disable carry transcript logging")
            .addBooleanOption((o) => o.setName("enabled").setDescription("Enabled").setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName("carrier-role-set")
            .setDescription("Set required role for claiming carry tickets")
            .addRoleOption((o) => o.setName("role").setDescription("Carrier role").setRequired(true))
        )
        .addSubcommand((s) => s.setName("carrier-role-show").setDescription("Show required role for claiming carry tickets"))
        .addSubcommand((s) => s.setName("carrier-role-clear").setDescription("Clear required role override for claiming carry tickets"))
    )
    .addSubcommandGroup((g) =>
      g
        .setName("catalog")
        .setDescription("Carry catalog settings")
        .addSubcommand((s) =>
          s
            .setName("add")
            .setDescription("Add carry type with tiers")
            .addStringOption((o) => o.setName("name").setDescription("Carry type").setRequired(true))
            .addStringOption((o) => o.setName("tiers").setDescription("Comma-separated tiers").setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName("remove")
            .setDescription("Remove carry type")
            .addStringOption((o) => o.setName("name").setDescription("Carry type").setRequired(true).setAutocomplete(true))
        )
        .addSubcommand((s) =>
          s
            .setName("price")
            .setDescription("Set tier price")
            .addStringOption((o) => o.setName("type").setDescription("Carry type").setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName("tier").setDescription("Tier").setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName("price").setDescription("Price (e.g. 400000, 400k, 1.5m)").setRequired(true))
        )
        .addSubcommand((s) =>
          s
            .setName("enable")
            .setDescription("Enable carry type")
            .addStringOption((o) => o.setName("type").setDescription("Carry type").setRequired(true).setAutocomplete(true))
        )
        .addSubcommand((s) =>
          s
            .setName("disable")
            .setDescription("Disable carry type")
            .addStringOption((o) => o.setName("type").setDescription("Carry type").setRequired(true).setAutocomplete(true))
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("queue")
        .setDescription("Queue controls")
        .addSubcommand((s) => s.setName("enable").setDescription("Enable queue"))
        .addSubcommand((s) => s.setName("disable").setDescription("Disable queue"))
        .addSubcommand((s) => s.setName("reset").setDescription("Reset queue and cancel queued carries"))
        .addSubcommand((s) => s.setName("repair").setDescription("Backfill missing carry channels/forum threads for active carries"))
        .addSubcommand((s) =>
          s
            .setName("priority")
            .setDescription("Set role queue priority")
            .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
            .addNumberOption((o) => o.setName("value").setDescription("Priority value").setRequired(true))
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("discount")
        .setDescription("Discount controls")
        .addSubcommand((s) =>
          s
            .setName("set")
            .setDescription("Set static global discount threshold")
            .addIntegerOption((o) => o.setName("amount").setDescription("Minimum amount").setRequired(true).setMinValue(1))
            .addNumberOption((o) => o.setName("percentage").setDescription("Discount percentage").setRequired(true).setMinValue(0).setMaxValue(95))
        )
        .addSubcommand((s) =>
          s
            .setName("remove")
            .setDescription("Remove static global discount")
            .addIntegerOption((o) => o.setName("amount").setRequired(true).setDescription("Minimum amount"))
        )
        .addSubcommand((s) =>
          s
            .setName("timed-global")
            .setDescription("Timed global discount")
            .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
            .addStringOption((o) => o.setName("duration").setRequired(true).setDescription("e.g. 3h, 2d"))
        )
        .addSubcommand((s) =>
          s
            .setName("timed-carry")
            .setDescription("Timed carry discount")
            .addStringOption((o) => o.setName("type").setRequired(true).setDescription("Carry type").setAutocomplete(true))
            .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
            .addStringOption((o) => o.setName("duration").setRequired(true).setDescription("e.g. 3h, 2d"))
            .addStringOption((o) => o.setName("tier").setDescription("Optional tier").setAutocomplete(true))
        )
        .addSubcommand((s) =>
          s
            .setName("timed-category")
            .setDescription("Timed category discount")
            .addStringOption((o) => o.setName("category").setRequired(true).setDescription("Category"))
            .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
            .addStringOption((o) => o.setName("duration").setRequired(true).setDescription("e.g. 3h, 2d"))
        )
        .addSubcommand((s) =>
          s
            .setName("bulk-category")
            .setDescription("Bulk category discount")
            .addStringOption((o) => o.setName("category").setRequired(true).setDescription("Category"))
            .addIntegerOption((o) => o.setName("amount").setRequired(true).setDescription("Min amount").setMinValue(1))
            .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
        )
        .addSubcommand((s) =>
          s
            .setName("bulk-carry")
            .setDescription("Bulk carry discount")
            .addStringOption((o) => o.setName("type").setRequired(true).setDescription("Carry type").setAutocomplete(true))
            .addStringOption((o) => o.setName("tier").setRequired(true).setDescription("Tier").setAutocomplete(true))
            .addIntegerOption((o) => o.setName("amount").setRequired(true).setDescription("Min amount").setMinValue(1))
            .addNumberOption((o) => o.setName("percentage").setRequired(true).setDescription("Percent").setMinValue(0).setMaxValue(95))
        )
        .addSubcommand((s) =>
          s
            .setName("stacking")
            .setDescription("Enable/disable stacking policy")
            .addBooleanOption((o) => o.setName("enabled").setRequired(true).setDescription("Enabled"))
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("freecarry")
        .setDescription("Free carry controls")
        .addSubcommand((s) => s.setName("reset-weekly").setDescription("Trigger weekly free carry reset log event"))
        .addSubcommand((s) =>
          s
            .setName("set-limit")
            .setDescription("Set free carries per week per user")
            .addIntegerOption((o) => o.setName("amount").setDescription("Limit").setRequired(true).setMinValue(0).setMaxValue(100))
        )
        .addSubcommand((s) =>
          s
            .setName("grant")
            .setDescription("Grant additional free carry credits to a user")
            .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
            .addIntegerOption((o) => o.setName("amount").setDescription("Additional credits").setRequired(true).setMinValue(1).setMaxValue(100))
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("ticket")
        .setDescription("Carry ticket actions")
        .addSubcommand((s) =>
          s
            .setName("mark-paid")
            .setDescription("Log paid amount on a carry")
            .addIntegerOption((o) => o.setName("carry_id").setDescription("Carry ID").setRequired(true).setMinValue(1))
            .addNumberOption((o) => o.setName("amount_or_runs").setDescription("Paid amount").setRequired(true).setMinValue(0))
        )
        .addSubcommand((s) =>
          s
            .setName("log-runs")
            .setDescription("Log completed runs for a carry")
            .addIntegerOption((o) => o.setName("carry_id").setDescription("Carry ID").setRequired(true).setMinValue(1))
            .addIntegerOption((o) => o.setName("runs").setDescription("Runs").setRequired(true).setMinValue(1))
        )
        .addSubcommand((s) =>
          s
            .setName("delete-old")
            .setDescription("Bulk delete old ticket entries")
            .addIntegerOption((o) => o.setName("before_ticket_id").setDescription("Delete tickets with ID lower than this").setMinValue(1))
            .addIntegerOption((o) => o.setName("older_than_days").setDescription("Delete tickets older than N days").setMinValue(1))
            .addIntegerOption((o) => o.setName("limit").setDescription("Max entries to process (default 100)").setMinValue(1).setMaxValue(1000))
            .addBooleanOption((o) => o.setName("dry_run").setDescription("Only show what would be deleted"))
        )
    )
    .addSubcommand((s) => s.setName("help").setDescription("Show carry admin command groups")),
  moderatorOnly: true,

  autocomplete: async (interaction) => {
    try {
      const carryService = interaction.client.carryService;
      if (!carryService?.db?.getConnection) {
        await interaction.respond([]);
        return;
      }

      const focused = interaction.options.getFocused(true);
      const focusedValue = String(focused?.value || "")
        .trim()
        .toLowerCase();
      const typeSelected = String(interaction.options.getString("type") || "")
        .trim()
        .toLowerCase();

      if (focused.name === "type" || focused.name === "name") {
        const rows = carryService.db.getConnection().prepare("SELECT DISTINCT lower(carry_type) AS carry_type FROM carry_catalog ORDER BY carry_type ASC").all();
        const choices = rows
          .map((r) => String(r.carry_type || ""))
          .filter(Boolean)
          .filter((v) => v.includes(focusedValue))
          .slice(0, 25)
          .map((v) => ({ name: v, value: v }));
        await interaction.respond(choices);
        return;
      }

      if (focused.name === "tier" && typeSelected) {
        const rows = carryService.db
          .getConnection()
          .prepare("SELECT DISTINCT lower(tier) AS tier FROM carry_catalog WHERE lower(carry_type)=lower(?) AND lower(tier) NOT IN ('5','t5') ORDER BY tier ASC")
          .all(typeSelected);
        const choices = rows
          .map((r) => String(r.tier || ""))
          .filter(Boolean)
          .filter((v) => v.includes(focusedValue))
          .slice(0, 25)
          .map((v) => ({ name: v, value: v }));
        await interaction.respond(choices);
        return;
      }

      await interaction.respond([]);
    } catch {
      await interaction.respond([]);
    }
  },

  execute: async (interaction) => {
    const carryService = interaction.client.carryService;
    const ticketService = interaction.client.ticketService;
    if (!carryService || !ticketService) {
      return interaction.editReply(errorPayload("Carry/Ticket services are not initialized."));
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);
    const now = Date.now();

    if (!group && sub === "help") {
      return interaction.editReply(
        successPayload(
          [
            "**/carryadmin help**",
            "`setup` - dashboards, logs forum, category, autodelete, transcript, carrier role",
            "`catalog` - add/remove carries, set tier price, enable/disable",
            "`queue` - enable/disable/reset/repair, role priority",
            "`discount` - static/timed/bulk/stacking controls",
            "`freecarry` - reset-weekly, set-limit, grant",
            "`ticket` - mark-paid, log-runs, delete-old"
          ].join("\n")
        )
      );
    }

    if (group === "setup") {
      if (sub === "carry-dashboard") {
        const channel = interaction.options.getChannel("channel", true);
        carryService.setCarryDashboardChannelId(channel.id);
        await carryService.publishCarryDashboard(channel.id);
        return interaction.editReply(successPayload(`Carry dashboard set to <#${channel.id}>.`));
      }

      if (sub === "carrier-dashboard") {
        const channel = interaction.options.getChannel("channel", true);
        carryService.setCarrierDashboardChannelId(channel.id);
        await carryService.publishCarrierDashboard(channel.id);
        return interaction.editReply(successPayload(`Carrier dashboard set to <#${channel.id}>.`));
      }

      if (sub === "carrier-stats") {
        const channel = interaction.options.getChannel("channel", true);
        carryService.setCarrierStatsChannelId(channel.id);
        await carryService.publishCarrierStatsDashboard(channel.id);
        return interaction.editReply(successPayload(`Carrier stats dashboard set to <#${channel.id}>.`));
      }

      if (sub === "ticket-dashboard") {
        const channel = interaction.options.getChannel("channel", true);
        ticketService.setTicketDashboardChannelId(channel.id);
        await ticketService.publishDashboard(channel.id);
        return interaction.editReply(successPayload(`Ticket dashboard set to <#${channel.id}>.`));
      }

      if (sub === "ticket-logs") {
        const forum = interaction.options.getChannel("forum_channel", true);
        ticketService.setTicketLogsForumId(forum.id);
        return interaction.editReply(successPayload(`Ticket logs forum set to <#${forum.id}>.`));
      }

      if (sub === "carry-category") {
        const category = interaction.options.getChannel("category", true);
        carryService.setCarryCategoryId(category.id);
        return interaction.editReply(successPayload(`Carry category set to **${category.name}**.`));
      }

      if (sub === "carry-autodelete") {
        const time = interaction.options.getString("time", true);
        const parsed = ms(time);
        if (!parsed || parsed <= 0) {
          return interaction.editReply(errorPayload("Invalid duration. Example: `30m`, `2h`."));
        }
        carryService.setCarryAutoDelete(parsed);
        return interaction.editReply(successPayload(`Carry autodelete set to **${time}**.`));
      }

      if (sub === "carry-transcript") {
        const enabled = interaction.options.getBoolean("enabled", true);
        carryService.setCarryTranscriptEnabled(enabled);
        return interaction.editReply(successPayload(`Carry transcript logging ${enabled ? "enabled" : "disabled"}.`));
      }

      if (sub === "carrier-role-set") {
        const role = interaction.options.getRole("role", true);
        carryService.setCarrierClaimRoleId(role.id);
        return interaction.editReply(successPayload(`Carrier claim role set to <@&${role.id}>.`));
      }

      if (sub === "carrier-role-show") {
        const roleId = carryService.getCarrierClaimRoleId();
        return interaction.editReply(successPayload(roleId ? `Carrier claim role: <@&${roleId}>` : "Carrier claim role override is not set."));
      }

      if (sub === "carrier-role-clear") {
        carryService.setCarrierClaimRoleId(null);
        return interaction.editReply(successPayload("Carrier claim role override cleared."));
      }
    }

    if (group === "catalog") {
      if (sub === "add") {
        const name = interaction.options.getString("name", true);
        const tiers = interaction.options.getString("tiers", true);
        if (
          String(name).toLowerCase() === "slayer_blaze" &&
          String(tiers)
            .toLowerCase()
            .split(",")
            .map((x) => x.trim())
            .some((x) => ["5", "t5"].includes(x))
        ) {
          return interaction.editReply(errorPayload("Blaze tier 5 is not available and cannot be added."));
        }
        const count = carryService.addCarryTypeWithTiers(name, tiers);
        await carryService.publishCarryDashboard().catch(() => {});
        return interaction.editReply(successPayload(`Added/updated ${count} tier(s) for **${name}**.`));
      }

      if (sub === "remove") {
        const name = interaction.options.getString("name", true);
        const changes = carryService.removeCarryType(name);
        await carryService.publishCarryDashboard().catch(() => {});
        return interaction.editReply(successPayload(`Removed ${changes} carry tier entries for **${name}**.`));
      }

      if (sub === "price") {
        const type = interaction.options.getString("type", true);
        const tier = interaction.options.getString("tier", true);
        if (isBlazeT5(type, tier)) {
          return interaction.editReply(errorPayload("Blaze tier 5 is not available and cannot be priced."));
        }
        const priceRaw = interaction.options.getString("price", true);
        const price = typeof carryService.parseCoinsInput === "function" ? carryService.parseCoinsInput(priceRaw) : Number(priceRaw);
        if (!Number.isFinite(price) || price < 0) {
          return interaction.editReply(errorPayload("Invalid price. Use values like `400000`, `400k`, `1.5m`."));
        }
        const updated = carryService.setCarryPrice(type, tier, price);
        if (!updated) return interaction.editReply(errorPayload("Carry type/tier not found."));
        await carryService.publishCarryDashboard().catch(() => {});
        const pretty = typeof carryService.formatCoinsShort === "function" ? carryService.formatCoinsShort(price) : String(price);
        return interaction.editReply(successPayload(`Set **${type} ${tier}** price to ${pretty}.`));
      }

      if (sub === "enable") {
        const type = interaction.options.getString("type", true);
        const changes = carryService.setCarryEnabled(type, true);
        if (!changes && String(type).toLowerCase() === "slayer_blaze") {
          return interaction.editReply(errorPayload("Blaze tier 5 remains blocked. Only tiers 1-4 can be enabled."));
        }
        await carryService.publishCarryDashboard().catch(() => {});
        return interaction.editReply(successPayload(`Enabled ${changes} entries for **${type}**.`));
      }

      if (sub === "disable") {
        const type = interaction.options.getString("type", true);
        const changes = carryService.setCarryEnabled(type, false);
        await carryService.publishCarryDashboard().catch(() => {});
        return interaction.editReply(successPayload(`Disabled ${changes} entries for **${type}**.`));
      }
    }

    if (group === "queue") {
      if (sub === "enable") {
        carryService.setQueueEnabled(true);
        return interaction.editReply(successPayload("Queue enabled."));
      }

      if (sub === "disable") {
        carryService.setQueueEnabled(false);
        return interaction.editReply(successPayload("Queue disabled."));
      }

      if (sub === "reset") {
        carryService.resetQueue();
        await carryService.publishCarrierDashboard();
        return interaction.editReply(successPayload("Queue reset complete."));
      }

      if (sub === "repair") {
        const result = await carryService.reconcileMissingCarryArtifacts();
        await carryService.publishCarrierDashboard().catch(() => {});
        const details = Array.isArray(result.errorDetails) && result.errorDetails.length ? `\nDetails: ${result.errorDetails.join(" | ")}` : "";
        return interaction.editReply(
          successPayload(
            `Repair done. Checked: ${result.checked}, forum threads fixed: ${result.threadBackfilled}, execution channels fixed: ${result.channelBackfilled}, errors: ${result.errors}.${details}`
          )
        );
      }

      if (sub === "priority") {
        const role = interaction.options.getRole("role", true);
        const value = interaction.options.getNumber("value", true);
        carryService.setRolePriority(role.id, value);
        return interaction.editReply(successPayload(`Role <@&${role.id}> priority set to ${value}.`));
      }
    }

    if (group === "discount") {
      if (sub === "set") {
        const amount = interaction.options.getInteger("amount", true);
        const percentage = interaction.options.getNumber("percentage", true);
        const id = carryService.addDiscountRule({ kind: "static", scope: "global", minAmount: amount, percentage });
        return interaction.editReply(successPayload(`Static discount rule #${id} created for amount >= ${amount}.`));
      }

      if (sub === "remove") {
        const amount = interaction.options.getInteger("amount", true);
        const changes = carryService.removeStaticDiscountByAmount(amount);
        return interaction.editReply(successPayload(`Removed ${changes} static discount rule(s) for amount >= ${amount}.`));
      }

      if (sub === "timed-global") {
        const percentage = interaction.options.getNumber("percentage", true);
        const duration = interaction.options.getString("duration", true);
        const durationMs = parseDuration(duration);
        if (!durationMs) return interaction.editReply(errorPayload("Invalid duration."));
        const id = carryService.addDiscountRule({ kind: "timed", scope: "global", percentage, startsAt: now, endsAt: now + durationMs });
        return interaction.editReply(successPayload(`Timed global discount #${id} created.`));
      }

      if (sub === "timed-carry") {
        const type = interaction.options.getString("type", true).toLowerCase();
        const tier = interaction.options.getString("tier")?.toLowerCase() || null;
        const percentage = interaction.options.getNumber("percentage", true);
        const duration = interaction.options.getString("duration", true);
        const durationMs = parseDuration(duration);
        if (!durationMs) return interaction.editReply(errorPayload("Invalid duration."));
        const id = carryService.addDiscountRule({ kind: "timed", scope: "carry", carryType: type, tier, percentage, startsAt: now, endsAt: now + durationMs });
        return interaction.editReply(successPayload(`Timed carry discount #${id} created.`));
      }

      if (sub === "timed-category") {
        const category = interaction.options.getString("category", true).toLowerCase();
        const percentage = interaction.options.getNumber("percentage", true);
        const duration = interaction.options.getString("duration", true);
        const durationMs = parseDuration(duration);
        if (!durationMs) return interaction.editReply(errorPayload("Invalid duration."));
        const id = carryService.addDiscountRule({ kind: "timed", scope: "category", category, percentage, startsAt: now, endsAt: now + durationMs });
        return interaction.editReply(successPayload(`Timed category discount #${id} created.`));
      }

      if (sub === "bulk-category") {
        const category = interaction.options.getString("category", true).toLowerCase();
        const amount = interaction.options.getInteger("amount", true);
        const percentage = interaction.options.getNumber("percentage", true);
        const id = carryService.addDiscountRule({ kind: "bulk", scope: "category", category, minAmount: amount, percentage });
        return interaction.editReply(successPayload(`Bulk category discount #${id} created.`));
      }

      if (sub === "bulk-carry") {
        const type = interaction.options.getString("type", true).toLowerCase();
        const tier = interaction.options.getString("tier", true).toLowerCase();
        const amount = interaction.options.getInteger("amount", true);
        const percentage = interaction.options.getNumber("percentage", true);
        const id = carryService.addDiscountRule({ kind: "bulk", scope: "carry", carryType: type, tier, minAmount: amount, percentage });
        return interaction.editReply(successPayload(`Bulk carry discount #${id} created.`));
      }

      if (sub === "stacking") {
        const enabled = interaction.options.getBoolean("enabled", true);
        carryService.db.setBinding("discount_stacking_enabled", enabled);
        return interaction.editReply(
          successPayload(`Stacking ${enabled ? "enabled" : "disabled"}. Policy still enforces only bulk + one scope discount and no multi-scope stacking.`)
        );
      }
    }

    if (group === "freecarry") {
      if (sub === "reset-weekly") {
        carryService.resetFreeCarryWeekly();
        return interaction.editReply(successPayload("Weekly reset marker recorded."));
      }

      if (sub === "set-limit") {
        const amount = interaction.options.getInteger("amount", true);
        carryService.setFreeCarryLimit(amount);
        return interaction.editReply(successPayload(`Free carry weekly limit set to ${amount}.`));
      }

      if (sub === "grant") {
        const user = interaction.options.getUser("user", true);
        const amount = interaction.options.getInteger("amount", true);
        const result = carryService.grantFreeCarryBonus(user.id, amount);
        if (!result.ok) {
          return interaction.editReply(errorPayload(result.reason));
        }
        return interaction.editReply(successPayload(`Granted ${amount} bonus free carry credit(s) to <@${user.id}>. Remaining bonus: ${result.remaining}.`));
      }
    }

    if (group === "ticket") {
      if (sub === "mark-paid") {
        const carryId = interaction.options.getInteger("carry_id", true);
        const amount = interaction.options.getNumber("amount_or_runs", true);
        const result = await carryService.markPaid(carryId, interaction.user.id, amount);
        if (!result.ok) {
          return interaction.editReply(errorPayload(result.reason));
        }
        const c = result.coverage;
        return interaction.editReply(
          successPayload(
            `Payment logged for carry #${carryId}.\nPaid total: \`${c.paidAmount}\`\nCovers runs: \`${c.coveredRuns}/${c.amount}\`\nRemaining payment: \`${c.remainingPayment}\`\nUnpaid runs left: \`${c.uncoveredRuns}\``
          )
        );
      }

      if (sub === "log-runs") {
        const carryId = interaction.options.getInteger("carry_id", true);
        const runs = interaction.options.getInteger("runs", true);
        const result = await carryService.logRuns(carryId, interaction.user.id, runs);
        if (result?.needsActorConfirm || result?.needsCustomerConfirm) {
          return interaction.editReply(successPayload(result.reason));
        }
        return interaction.editReply(
          result.ok
            ? successPayload(`Runs logged for carry #${carryId}.${result.reached ? " Target reached and customer confirmation requested." : ""}`)
            : errorPayload(result.reason)
        );
      }

      if (sub === "delete-old") {
        const beforeTicketId = interaction.options.getInteger("before_ticket_id");
        const olderThanDays = interaction.options.getInteger("older_than_days");
        const limit = interaction.options.getInteger("limit") || 100;
        const dryRun = interaction.options.getBoolean("dry_run") || false;

        const result = await ticketService.deleteOldTicketEntries({
          beforeTicketId,
          olderThanDays,
          limit,
          actorId: interaction.user.id,
          dryRun
        });

        if (!result.ok) {
          return interaction.editReply(errorPayload(result.reason));
        }

        if (result.dryRun) {
          const preview = result.ids.slice(0, 25).join(", ");
          return interaction.editReply(successPayload(`Dry run matched **${result.matched}** ticket(s).\nIDs: ${preview || "none"}${result.matched > 25 ? " ..." : ""}`));
        }

        const details = result.errorDetails?.length ? `\nErrors: ${result.errorDetails.join(" | ")}` : "";
        return interaction.editReply(
          successPayload(`Delete-old complete. Matched: **${result.matched}**, deleted: **${result.deleted}**, failed: **${result.failed}**.${details}`)
        );
      }
    }

    return interaction.editReply(errorPayload("Unknown carryadmin subcommand."));
  }
};
