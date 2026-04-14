const HypixelDiscordChatBridgeError = require("../../contracts/errorHandler.js");
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const hypixel = require("../../contracts/API/HypixelRebornAPI.js");
const { getUUID, getUsername } = require("../../contracts/API/mowojangAPI.js");
const { getAllLinks } = require("../../contracts/linkedStore.js");
const { Embed } = require("../../contracts/embedHandler.js");
const activityTracker = require("../other/activityTracker.js");
const { readFileSync } = require("fs");
const config = require('../../config');

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOCOMPLETE_CACHE_MS = 10 * 60 * 1000;
const usernameAutocompleteCache = {
  usernames: [],
  expiresAt: 0,
  refreshing: false
};

function getActivityConfig() {
  const defaults = {
    inactiveDays: 14,
    warningDays: 7,
    pageSize: 10,
    buttonTimeoutMs: 120000,
    apiConcurrency: 6
  };

  const activity = config?.discord?.activity || {};
  return {
    inactiveDays: Number.isFinite(activity.inactiveDays) ? activity.inactiveDays : defaults.inactiveDays,
    warningDays: Number.isFinite(activity.warningDays) ? activity.warningDays : defaults.warningDays,
    pageSize: Number.isFinite(activity.pageSize) ? activity.pageSize : defaults.pageSize,
    buttonTimeoutMs: Number.isFinite(activity.buttonTimeoutMs) ? activity.buttonTimeoutMs : defaults.buttonTimeoutMs,
    apiConcurrency: Number.isFinite(activity.apiConcurrency) ? activity.apiConcurrency : defaults.apiConcurrency
  };
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    return value < 1000000000000 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getDaysSince(timestamp, nowTs = Date.now()) {
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, Math.floor((nowTs - timestamp) / DAY_MS));
}

function getStatus(lastActivityTs, nowTs, thresholds) {
  const days = getDaysSince(lastActivityTs, nowTs);
  if (days === null) {
    return "WARNING";
  }

  if (days >= thresholds.inactiveDays) {
    return "INACTIVE";
  }

  if (days >= thresholds.warningDays) {
    return "WARNING";
  }

  return "ACTIVE";
}

function statusSeverity(status) {
  switch (status) {
    case "INACTIVE":
      return 0;
    case "WARNING":
      return 1;
    default:
      return 2;
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatLastSeen(lastSeenTs, nowTs) {
  const days = getDaysSince(lastSeenTs, nowTs);
  if (days === null) {
    return "unknown";
  }

  return `${days}d ago`;
}

function readJsonFile(path, fallback = {}) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // ignore
  }

  return fallback;
}

function runWithConcurrency(items, limit, worker) {
  const safeLimit = Math.max(1, Math.floor(limit));
  const results = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;

      results[current] = await worker(items[current], current);
    }
  });

  return Promise.all(runners).then(() => results);
}

function sortItems(items, sortBy = "status") {
  const sorted = [...items];

  switch (sortBy) {
    case "last_login":
      sorted.sort((a, b) => {
        const aDays = a.daysSinceLogin ?? -1;
        const bDays = b.daysSinceLogin ?? -1;
        return bDays - aDays || statusSeverity(a.status) - statusSeverity(b.status);
      });
      return sorted;

    case "gexp":
      sorted.sort((a, b) => b.weeklyExperience - a.weeklyExperience || statusSeverity(a.status) - statusSeverity(b.status));
      return sorted;

    case "chat_30d":
      sorted.sort((a, b) => b.chat30d - a.chat30d || statusSeverity(a.status) - statusSeverity(b.status));
      return sorted;

    case "playtime_30d":
      sorted.sort((a, b) => b.playtime30dSeconds - a.playtime30dSeconds || statusSeverity(a.status) - statusSeverity(b.status));
      return sorted;

    case "status":
    default:
      sorted.sort((a, b) => {
        const severityDiff = statusSeverity(a.status) - statusSeverity(b.status);
        if (severityDiff !== 0) {
          return severityDiff;
        }

        const aDays = a.daysSinceLogin ?? -1;
        const bDays = b.daysSinceLogin ?? -1;
        if (bDays !== aDays) {
          return bDays - aDays;
        }

        return a.username.localeCompare(b.username);
      });
      return sorted;
  }
}

function applyStatusFilter(items, statusFilter) {
  if (!statusFilter || statusFilter === "all") {
    return items;
  }

  const normalized = statusFilter.toUpperCase();
  return items.filter((item) => item.status === normalized);
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getStatusCounts(items) {
  return items.reduce(
    (acc, item) => {
      acc[item.status] += 1;
      return acc;
    },
    { INACTIVE: 0, WARNING: 0, ACTIVE: 0 }
  );
}

function buildMemberLine(item) {
  const linked = item.discordId ? ` | <@${item.discordId}>` : "";
  const inactiveNotice = item.inactivityNotice ? " | excused" : "";
  return `\`[${item.status}]\` **${item.username}**${linked} | last: \`${formatLastSeen(item.lastActivityTs, item.nowTs)}\` | play: \`${formatDuration(
    item.playtime30dSeconds
  )}\` | chat: \`${item.chat30d}\` | gexp: \`${item.weeklyExperience.toLocaleString()}\`${inactiveNotice}`;
}

function buildGuildPageEmbed({ pageItems, pageIndex, totalPages, totalItems, counts, statusFilter, sortBy }) {
  const description = pageItems.length === 0 ? "No guild members matched this query." : pageItems.map((item) => buildMemberLine(item)).join("\n");

  return new Embed()
    .setTitle("Guild Activity Audit")
    .setDescription(description)
    .addFields({
      name: "Summary",
      value: `INACTIVE: \`${counts.INACTIVE}\` | WARNING: \`${counts.WARNING}\` | ACTIVE: \`${counts.ACTIVE}\` | Total: \`${totalItems}\`\nFilter: \`${statusFilter}\` | Sort: \`${sortBy}\``
    })
    .setFooter({ text: `Page ${pageIndex + 1}/${totalPages}` });
}

function buildMemberEmbed(item) {
  const linked = item.discordId ? `<@${item.discordId}>` : "Not linked";
  const lastLogin = formatLastSeen(item.lastActivityTs, item.nowTs);
  const inactivityLine = item.inactivityNotice ? `Yes - ${item.inactivityReason || "No reason provided"}` : "No";

  return new Embed()
    .setTitle(`Activity Check: ${item.username}`)
    .setDescription(
      `Status: \`${item.status}\`\nDiscord: ${linked}\nGuild Rank: \`${item.guildRank || "Unknown"}\`\nLast Login: \`${lastLogin}\`\nPlaytime (30d): \`${formatDuration(
        item.playtime30dSeconds
      )}\`\nChat (30d): \`${item.chat30d}\`\nWeekly GEXP: \`${item.weeklyExperience.toLocaleString()}\`\nInactivity Notice: \`${inactivityLine}\``
    );
}

async function buildAuditItem({ guildMember, inactivityMap, linkedMap, nowTs, thresholds }) {
  const snapshot = activityTracker.getActivitySnapshot(guildMember.uuid, nowTs);

  let player = null;
  try {
    player = await hypixel.getPlayer(guildMember.uuid, { guild: false });
  } catch {
    player = null;
  }

  const lastLoginTs = normalizeTimestamp(player?.lastLogin);
  const trackerLastSeenTs = normalizeTimestamp(snapshot.lastSeenTs);
  const lastActivityTs = lastLoginTs ?? trackerLastSeenTs ?? null;
  const status = getStatus(lastActivityTs, nowTs, thresholds);

  return {
    uuid: guildMember.uuid,
    username: player?.nickname || guildMember.uuid,
    guildRank: guildMember.rank || "",
    weeklyExperience: Number(guildMember.weeklyExperience) || 0,
    discordId: linkedMap[guildMember.uuid] || null,
    inactivityNotice: Boolean(inactivityMap[guildMember.uuid]),
    inactivityReason: inactivityMap[guildMember.uuid]?.reason || null,
    playtime30dSeconds: snapshot.playtime30dSeconds,
    chat30d: snapshot.chat30dCount,
    lastActivityTs,
    daysSinceLogin: getDaysSince(lastActivityTs, nowTs),
    status,
    nowTs
  };
}

async function resolveGuildData(nowTs) {
  const guild = await hypixel.getGuild("player", bot.username, { noCaching: true, noCacheCheck: true });
  if (!guild) {
    throw new HypixelDiscordChatBridgeError("Failed to fetch guild data.");
  }

  const linkedMap = getAllLinks();
  const inactivityMap = readJsonFile("data/inactivity.json", {});
  return {
    nowTs,
    members: guild.members || [],
    linkedMap,
    inactivityMap
  };
}

async function resolveTargetMember({ guildMembers, userOption, usernameOption, linkedMap }) {
  if (userOption) {
    const uuid = Object.entries(linkedMap).find(([, discordId]) => discordId === userOption.id)?.[0];
    if (!uuid) {
      throw new HypixelDiscordChatBridgeError("That Discord user is not linked to a Minecraft account.");
    }

    const guildMember = guildMembers.find((member) => member.uuid === uuid);
    if (!guildMember) {
      throw new HypixelDiscordChatBridgeError("Linked player is not in the guild.");
    }

    return guildMember;
  }

  if (usernameOption) {
    const uuid = await getUUID(usernameOption);
    const guildMember = guildMembers.find((member) => member.uuid === uuid);
    if (!guildMember) {
      throw new HypixelDiscordChatBridgeError("That player is not in the guild.");
    }

    return guildMember;
  }

  return null;
}

function buildNavigationRow(pageIndex, totalPages, interactionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`checkactivity:prev:${interactionId}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex <= 0),
    new ButtonBuilder().setCustomId(`checkactivity:jump:${interactionId}`).setLabel("Jump").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`checkactivity:next:${interactionId}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex >= totalPages - 1)
  );
}

async function refreshGuildUsernameCache() {
  if (usernameAutocompleteCache.refreshing) {
    return;
  }

  usernameAutocompleteCache.refreshing = true;
  try {
    const guild = await hypixel.getGuild("player", bot.username, { noCaching: true, noCacheCheck: true });
    const members = guild?.members || [];
    if (members.length === 0) {
      usernameAutocompleteCache.expiresAt = Date.now() + AUTOCOMPLETE_CACHE_MS;
      return;
    }

    const maybeNames = members.map((member) => member.nickname || member.name || null).filter((value) => typeof value === "string" && value.length > 0);

    let usernames = [];
    if (maybeNames.length > 0) {
      usernames = maybeNames;
    } else {
      const settings = getActivityConfig();
      usernames = await runWithConcurrency(members, settings.apiConcurrency, async (member) => {
        try {
          return await getUsername(member.uuid);
        } catch {
          return null;
        }
      });
    }

    usernameAutocompleteCache.usernames = [...new Set(usernames.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    usernameAutocompleteCache.expiresAt = Date.now() + AUTOCOMPLETE_CACHE_MS;
  } catch {
    usernameAutocompleteCache.expiresAt = Date.now() + 60000;
  } finally {
    usernameAutocompleteCache.refreshing = false;
  }
}

async function getAutocompleteUsernames() {
  const now = Date.now();
  if (usernameAutocompleteCache.usernames.length > 0 && now < usernameAutocompleteCache.expiresAt) {
    return usernameAutocompleteCache.usernames;
  }

  if (!usernameAutocompleteCache.refreshing) {
    await refreshGuildUsernameCache();
  }

  return usernameAutocompleteCache.usernames;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("checkactivity")
    .setDescription("Audit guild member activity or check one member.")
    .addUserOption((option) => option.setName("user").setDescription("Discord user to check"))
    .addStringOption((option) => option.setName("username").setDescription("Minecraft username to check").setAutocomplete(true))
    .addStringOption((option) =>
      option
        .setName("status")
        .setDescription("Status filter (guild view only)")
        .addChoices({ name: "All", value: "all" }, { name: "Inactive", value: "inactive" }, { name: "Warning", value: "warning" }, { name: "Active", value: "active" })
    )
    .addStringOption((option) =>
      option
        .setName("sort")
        .setDescription("Sort order (guild view only)")
        .addChoices(
          { name: "Status", value: "status" },
          { name: "Last Login", value: "last_login" },
          { name: "Guild XP", value: "gexp" },
          { name: "Chat 30d", value: "chat_30d" },
          { name: "Playtime 30d", value: "playtime_30d" }
        )
    ),
  moderatorOnly: true,
  requiresBot: true,
  autocomplete: async (interaction) => {
    try {
      const focused = String(interaction.options.getFocused() || "")
        .trim()
        .toLowerCase();
      const usernames = await getAutocompleteUsernames();
      const matches = usernames
        .filter((name) => name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((name) => ({ name, value: name }));

      await interaction.respond(matches);
    } catch {
      await interaction.respond([]);
    }
  },

  execute: async (interaction) => {
    const userOption = interaction.options.getUser("user");
    const usernameOption = interaction.options.getString("username");

    if (userOption && usernameOption) {
      throw new HypixelDiscordChatBridgeError("Use either `user` or `username`, not both.");
    }

    const statusFilter = interaction.options.getString("status") || "all";
    const sortBy = interaction.options.getString("sort") || "status";
    const settings = getActivityConfig();
    const nowTs = Date.now();

    const { members, linkedMap, inactivityMap } = await resolveGuildData(nowTs);
    const targetGuildMember = await resolveTargetMember({
      guildMembers: members,
      userOption,
      usernameOption,
      linkedMap
    });

    const thresholds = {
      inactiveDays: settings.inactiveDays,
      warningDays: settings.warningDays
    };

    if (targetGuildMember) {
      const item = await buildAuditItem({ guildMember: targetGuildMember, inactivityMap, linkedMap, nowTs, thresholds });
      const embed = buildMemberEmbed(item);
      await interaction.editReply({ embeds: [embed], components: [] });
      return;
    }

    const items = await runWithConcurrency(members, settings.apiConcurrency, async (guildMember) =>
      buildAuditItem({ guildMember, inactivityMap, linkedMap, nowTs, thresholds })
    );

    const filtered = applyStatusFilter(items, statusFilter);
    const sorted = sortItems(filtered, sortBy);
    const counts = getStatusCounts(filtered);
    const pages = chunk(sorted, Math.max(1, settings.pageSize));

    if (pages.length === 0) {
      const emptyEmbed = buildGuildPageEmbed({
        pageItems: [],
        pageIndex: 0,
        totalPages: 1,
        totalItems: 0,
        counts,
        statusFilter,
        sortBy
      });
      await interaction.editReply({ embeds: [emptyEmbed], components: [] });
      return;
    }

    let pageIndex = 0;
    const firstEmbed = buildGuildPageEmbed({
      pageItems: pages[pageIndex],
      pageIndex,
      totalPages: pages.length,
      totalItems: filtered.length,
      counts,
      statusFilter,
      sortBy
    });

    const initialComponents = pages.length > 1 ? [buildNavigationRow(pageIndex, pages.length, interaction.id)] : [];
    const reply = await interaction.editReply({ embeds: [firstEmbed], components: initialComponents });

    if (pages.length <= 1) {
      return;
    }

    const collector = reply.createMessageComponentCollector({
      time: settings.buttonTimeoutMs
    });

    collector.on("collect", async (buttonInteraction) => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        await buttonInteraction.reply({ content: "Only the command invoker can use these buttons.", ephemeral: true });
        return;
      }

      if (buttonInteraction.customId === `checkactivity:prev:${interaction.id}`) {
        pageIndex = Math.max(0, pageIndex - 1);
      }

      if (buttonInteraction.customId === `checkactivity:next:${interaction.id}`) {
        pageIndex = Math.min(pages.length - 1, pageIndex + 1);
      }

      if (buttonInteraction.customId === `checkactivity:jump:${interaction.id}`) {
        const modal = new ModalBuilder().setCustomId(`checkactivity:jumpmodal:${interaction.id}`).setTitle("Jump To Page");
        const input = new TextInputBuilder().setCustomId("page").setLabel(`Page number (1-${pages.length})`).setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await buttonInteraction.showModal(modal);

        const modalSubmit = await buttonInteraction
          .awaitModalSubmit({
            time: settings.buttonTimeoutMs,
            filter: (m) => m.customId === `checkactivity:jumpmodal:${interaction.id}` && m.user.id === interaction.user.id
          })
          .catch(() => null);

        if (!modalSubmit) {
          return;
        }

        const requested = parseInt(modalSubmit.fields.getTextInputValue("page"), 10);
        if (!Number.isFinite(requested) || requested < 1 || requested > pages.length) {
          await modalSubmit.reply({ content: `Enter a valid page between 1 and ${pages.length}.`, ephemeral: true });
          return;
        }

        pageIndex = requested - 1;
        const jumpEmbed = buildGuildPageEmbed({
          pageItems: pages[pageIndex],
          pageIndex,
          totalPages: pages.length,
          totalItems: filtered.length,
          counts,
          statusFilter,
          sortBy
        });

        await modalSubmit.update({
          embeds: [jumpEmbed],
          components: [buildNavigationRow(pageIndex, pages.length, interaction.id)]
        });
        return;
      }

      const embed = buildGuildPageEmbed({
        pageItems: pages[pageIndex],
        pageIndex,
        totalPages: pages.length,
        totalItems: filtered.length,
        counts,
        statusFilter,
        sortBy
      });

      await buttonInteraction.update({
        embeds: [embed],
        components: [buildNavigationRow(pageIndex, pages.length, interaction.id)]
      });
    });

    collector.on("end", async () => {
      const embed = buildGuildPageEmbed({
        pageItems: pages[pageIndex],
        pageIndex,
        totalPages: pages.length,
        totalItems: filtered.length,
        counts,
        statusFilter,
        sortBy
      });

      await interaction
        .editReply({
          embeds: [embed],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`checkactivity:prev:${interaction.id}:disabled`).setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId(`checkactivity:jump:${interaction.id}:disabled`).setLabel("Jump").setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId(`checkactivity:next:${interaction.id}:disabled`).setLabel("Next").setStyle(ButtonStyle.Primary).setDisabled(true)
            )
          ]
        })
        .catch(() => {});
    });
  },

  _private: {
    getStatus,
    getDaysSince,
    sortItems,
    applyStatusFilter,
    getActivityConfig
  }
};
