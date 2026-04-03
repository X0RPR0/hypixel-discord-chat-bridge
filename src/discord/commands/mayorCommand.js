const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { get } = require("axios");
const { Embed } = require("../../contracts/embedHandler.js");
const { dayMs, monthMs, yearMs, yearZero } = require("../../../API/constants/calendar.js");

const BUTTON_TIMEOUT_MS = 120000;
const BAR_WIDTH = 20;
const FISHING_FESTIVAL_MONTH_DAY_OFFSETS = [0, 1, 2];
const COLE_MONTH_INDEXES = [4, 5, 6, 7, 8];
const MAYOR_DYNAMIC_SCHEDULE_PERKS = new Set(["Extra Event", "Perkpocalypse"]);

function getSkyblockYear(timeMs) {
  return Math.floor((timeMs - yearZero) / yearMs) + 1;
}

function getSkyblockYearStart(year) {
  return yearZero + (year - 1) * yearMs;
}

function getSpecialMayorForYear(year) {
  const mod = year % 24;
  if (mod === 8) return "Derpy";
  if (mod === 16) return "Jerry";
  if (mod === 0) return "Scorpius";
  return "Unknown";
}

function getNextSpecialMayor(nowMs) {
  const currentYear = getSkyblockYear(nowMs);
  let nextYear = currentYear + 1;
  while (nextYear % 8 !== 0) {
    nextYear += 1;
  }

  return {
    currentYear,
    year: nextYear,
    mayor: getSpecialMayorForYear(nextYear),
    timestamp: getSkyblockYearStart(nextYear)
  };
}

function buildProgressBar(percentage) {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = Math.max(0, BAR_WIDTH - filled);
  return `[${"#".repeat(filled)}${"-".repeat(empty)}]`;
}

function mapCandidates(candidates) {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  const sorted = [...safeCandidates].sort((a, b) => (b.votes || 0) - (a.votes || 0));
  const totalVotes = sorted.reduce((sum, candidate) => sum + (candidate.votes || 0), 0);

  return sorted.map((candidate) => {
    const votes = candidate.votes || 0;
    const percentage = totalVotes > 0 ? (votes / totalVotes) * 100 : 0;
    return {
      name: candidate.name || "Unknown",
      votes,
      percentage
    };
  });
}

function findUpcomingMarinaEvents(nowMs, take = 2) {
  const starts = [];
  let year = getSkyblockYear(nowMs);

  while (starts.length < take) {
    const yearStart = getSkyblockYearStart(year);
    for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
      for (const dayOffset of FISHING_FESTIVAL_MONTH_DAY_OFFSETS) {
        const start = yearStart + monthIndex * monthMs + dayOffset * dayMs;
        if (start >= nowMs) {
          starts.push({ type: "Fishing Festival", timestamp: start });
          if (starts.length >= take) {
            break;
          }
        }
      }

      if (starts.length >= take) {
        break;
      }
    }
    year += 1;
  }

  return starts.sort((a, b) => a.timestamp - b.timestamp).slice(0, take);
}

function findUpcomingColeEvents(nowMs, take = 2) {
  const starts = [];
  let year = getSkyblockYear(nowMs);

  while (starts.length < take) {
    const yearStart = getSkyblockYearStart(year);
    for (const monthIndex of COLE_MONTH_INDEXES) {
      const start = yearStart + monthIndex * monthMs;
      if (start >= nowMs) {
        starts.push({ type: "Mining Fiesta", timestamp: start });
        if (starts.length >= take) {
          break;
        }
      }
    }
    year += 1;
  }

  return starts.sort((a, b) => a.timestamp - b.timestamp).slice(0, take);
}

function resolveScheduledMayorEvents(mayor, nowMs) {
  const perks = Array.isArray(mayor?.perks) ? mayor.perks : [];
  const perkNames = perks.map((perk) => String(perk?.name || ""));
  const eventEntries = [];
  const notes = [];

  if (perkNames.includes("Fishing Festival")) {
    eventEntries.push(...findUpcomingMarinaEvents(nowMs, 2));
  }

  if (perkNames.includes("Mining Fiesta")) {
    eventEntries.push(...findUpcomingColeEvents(nowMs, 2));
  }

  const dynamic = perkNames.filter((name) => MAYOR_DYNAMIC_SCHEDULE_PERKS.has(name));
  if (dynamic.length > 0) {
    notes.push(`Dynamic perk schedule unavailable from API/math alone: ${dynamic.join(", ")}`);
  }

  const sorted = eventEntries.sort((a, b) => a.timestamp - b.timestamp).slice(0, 2);

  return {
    events: sorted,
    notes
  };
}

function formatMayorEventSection(mayor, nowMs) {
  const resolved = resolveScheduledMayorEvents(mayor, nowMs);
  if (resolved.events.length === 0 && resolved.notes.length === 0) {
    return null;
  }

  const lines = [];
  const [event1, event2] = resolved.events;
  if (event1) {
    lines.push(`Next Event: <t:${Math.floor(event1.timestamp / 1000)}:F> (in <t:${Math.floor(event1.timestamp / 1000)}:R>)`);
    lines.push(`Event 1: <t:${Math.floor(event1.timestamp / 1000)}:F> (${event1.type})`);
  }
  if (event2) {
    lines.push(`Event 2: <t:${Math.floor(event2.timestamp / 1000)}:F> (${event2.type})`);
  }

  for (const note of resolved.notes) {
    lines.push(note);
  }

  return lines.join("\n");
}

function buildMayorBaseEmbed(data, nowMs) {
  const mayor = data?.mayor || {};
  const mayorPerks = Array.isArray(mayor.perks) ? mayor.perks.map((perk) => perk.name).join(", ") : "Unknown";
  const ministerPerk = mayor?.minister?.perk?.name || "None";
  const eventSection = formatMayorEventSection(mayor, nowMs);

  const embed = new Embed()
    .setTitle(`SkyBlock Mayor: ${mayor.name || "Unknown"}`)
    .setDescription(`Current Year: \`${data?.current?.year || "Unknown"}\``)
    .addFields(
      {
        name: "Perks",
        value: mayorPerks || "None"
      },
      {
        name: "Minister Perk",
        value: ministerPerk
      }
    );

  if (eventSection) {
    embed.addFields({
      name: "Scheduled Events",
      value: eventSection
    });
  }

  return embed;
}

function buildNextSpecialMayorField(nowMs) {
  const info = getNextSpecialMayor(nowMs);
  return {
    name: "Next Special Mayor",
    value: `Mayor: \`${info.mayor}\`\nSkyBlock Year: \`${info.year}\`\nExpected At: <t:${Math.floor(info.timestamp / 1000)}:F> (<t:${Math.floor(
      info.timestamp / 1000
    )}:R>)`
  };
}

function buildElectionField(data) {
  const election = data?.mayor?.election;
  if (!election || !Array.isArray(election.candidates) || election.candidates.length === 0) {
    return {
      name: "Current Election",
      value: "No active candidates available."
    };
  }

  const lines = mapCandidates(election.candidates).map(
    (candidate) =>
      `**${candidate.name}** - \`${candidate.votes.toLocaleString()}\` votes (${candidate.percentage.toFixed(2)}%)\n${buildProgressBar(candidate.percentage)}`
  );

  return {
    name: `Current Election (Year ${election.year || "Unknown"})`,
    value: lines.join("\n")
  };
}

function buildButtons(interactionId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mayor:next_special:${interactionId}`).setLabel("Next Special Mayor").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`mayor:election:${interactionId}`).setLabel("Current Election").setStyle(ButtonStyle.Primary).setDisabled(disabled)
    )
  ];
}

function buildEmbedForMode(mode, data, nowMs) {
  const embed = buildMayorBaseEmbed(data, nowMs);
  if (mode === "next_special") {
    embed.addFields(buildNextSpecialMayorField(nowMs));
  }
  if (mode === "election") {
    embed.addFields(buildElectionField(data));
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder().setName("mayor").setDescription("Show current SkyBlock mayor details and election info."),
  execute: async (interaction) => {
    const response = await get("https://api.hypixel.net/v2/resources/skyblock/election");
    if (!response?.data?.success) {
      throw new Error("Request to Hypixel API failed. Please try again.");
    }

    const electionData = response.data;
    const nowMs = Date.now();
    const baseEmbed = buildEmbedForMode("base", electionData, nowMs);
    const components = buildButtons(interaction.id, false);
    const reply = await interaction.editReply({ embeds: [baseEmbed], components });

    if (!reply || typeof reply.createMessageComponentCollector !== "function") {
      return;
    }

    const collector = reply.createMessageComponentCollector({
      time: BUTTON_TIMEOUT_MS
    });

    collector.on("collect", async (buttonInteraction) => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        await buttonInteraction.reply({ content: "Only the command invoker can use these buttons.", ephemeral: true });
        return;
      }

      let mode = "base";
      if (buttonInteraction.customId === `mayor:next_special:${interaction.id}`) {
        mode = "next_special";
      }
      if (buttonInteraction.customId === `mayor:election:${interaction.id}`) {
        mode = "election";
      }

      const refreshed = await get("https://api.hypixel.net/v2/resources/skyblock/election");
      const refreshedData = refreshed?.data?.success ? refreshed.data : electionData;
      const embed = buildEmbedForMode(mode, refreshedData, Date.now());
      await buttonInteraction.update({ embeds: [embed], components: buildButtons(interaction.id, false) });
    });

    collector.on("end", async () => {
      await interaction
        .editReply({
          components: buildButtons(interaction.id, true)
        })
        .catch(() => {});
    });
  },
  _private: {
    buildProgressBar,
    mapCandidates,
    getNextSpecialMayor,
    resolveScheduledMayorEvents,
    formatMayorEventSection,
    buildElectionField,
    buildEmbedForMode
  }
};
