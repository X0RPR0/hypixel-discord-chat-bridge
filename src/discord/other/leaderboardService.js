const { Embed } = require("../../contracts/embedHandler.js");
const hypixel = require("../../contracts/API/HypixelRebornAPI.js");
const activityTracker = require("./activityTracker.js");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const config = require('../../config');

const STATE_PATH = "data/leaderboard.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_KEEP_MS = 30 * 60 * 60 * 1000;

function getLeaderboardConfig() {
  const defaults = {
    autoUpdateMinutes: 15,
    defaultTop: 15,
    maxTop: 50,
    defaultMetric: "score",
    apiConcurrency: 6
  };

  const leaderboard = config?.discord?.leaderboard || {};
  return {
    autoUpdateMinutes: Number.isFinite(leaderboard.autoUpdateMinutes) ? leaderboard.autoUpdateMinutes : defaults.autoUpdateMinutes,
    defaultTop: Number.isFinite(leaderboard.defaultTop) ? leaderboard.defaultTop : defaults.defaultTop,
    maxTop: Number.isFinite(leaderboard.maxTop) ? leaderboard.maxTop : defaults.maxTop,
    defaultMetric: typeof leaderboard.defaultMetric === "string" ? leaderboard.defaultMetric : defaults.defaultMetric,
    apiConcurrency: Number.isFinite(leaderboard.apiConcurrency) ? leaderboard.apiConcurrency : defaults.apiConcurrency
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

function getDaysSince(ts, nowTs = Date.now()) {
  if (!Number.isFinite(ts)) {
    return null;
  }

  return Math.max(0, Math.floor((nowTs - ts) / DAY_MS));
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}m`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return `${Math.floor(number)}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
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

function computeActivityScores(items) {
  const maxGexp = Math.max(1, ...items.map((item) => item.weeklyExperience || 0));
  const maxChat = Math.max(1, ...items.map((item) => item.chat30d || 0));
  const maxPlay = Math.max(1, ...items.map((item) => item.playtime30dSeconds || 0));

  return items.map((item) => {
    const days = item.daysSinceActivity;
    const recency = days === null ? 0 : Math.max(0, 1 - Math.min(days / 30, 1));
    const gexpNorm = (item.weeklyExperience || 0) / maxGexp;
    const chatNorm = (item.chat30d || 0) / maxChat;
    const playNorm = (item.playtime30dSeconds || 0) / maxPlay;

    const score = (recency * 0.35 + chatNorm * 0.2 + playNorm * 0.2 + gexpNorm * 0.25) * 100;
    return {
      ...item,
      activityScore: Number(score.toFixed(2))
    };
  });
}

function getMetricValue(item, metric) {
  switch (metric) {
    case "gexp":
      return item.weeklyExperience || 0;
    case "chat_30d":
      return item.chat30d || 0;
    case "playtime_30d":
      return item.playtime30dSeconds || 0;
    case "score":
    default:
      return item.activityScore || 0;
  }
}

function sortLeaderboard(items, metric) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const metricDiff = getMetricValue(b, metric) - getMetricValue(a, metric);
    if (metricDiff !== 0) {
      return metricDiff;
    }

    const gexpDiff = (b.weeklyExperience || 0) - (a.weeklyExperience || 0);
    if (gexpDiff !== 0) {
      return gexpDiff;
    }

    return (a.username || "").localeCompare(b.username || "");
  });

  return sorted;
}

function formatMetricValue(metric, value) {
  switch (metric) {
    case "score":
      return Number(value || 0).toFixed(2);
    case "playtime_30d":
      return formatDuration(value || 0);
    default:
      return compactNumber(value || 0);
  }
}

function getMetricLabel(metric) {
  switch (metric) {
    case "gexp":
      return "GEXP";
    case "chat_30d":
      return "Chat 30d";
    case "playtime_30d":
      return "Playtime 30d";
    case "score":
    default:
      return "Score";
  }
}

function getTrendLabel(gain, metric) {
  if (gain > 0) {
    return `⬆️ +${formatMetricValue(metric, gain)}`;
  }

  if (gain < 0) {
    return `⬇️ ${formatMetricValue(metric, gain)}`;
  }

  return "⏸ 0";
}

function chunk(items, size) {
  const output = [];
  for (let i = 0; i < items.length; i += size) {
    output.push(items.slice(i, i + size));
  }

  return output;
}

function findReferenceSnapshot(snapshots, nowTs) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return null;
  }

  const targetTs = nowTs - DAY_MS;
  const sorted = [...snapshots].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const candidates = sorted.filter((snapshot) => Number.isFinite(snapshot.ts));
  if (candidates.length === 0) {
    return null;
  }

  let best = null;
  let bestDiff = Infinity;
  for (const candidate of candidates) {
    const diff = Math.abs(candidate.ts - targetTs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  if (bestDiff > 3 * 60 * 60 * 1000) {
    return null;
  }

  return best;
}

function computeGain(currentItem, referenceSnapshot, metric) {
  if (!referenceSnapshot?.members || !currentItem?.uuid) {
    return 0;
  }

  const reference = referenceSnapshot.members[currentItem.uuid];
  if (!reference || typeof reference !== "object") {
    return 0;
  }

  const currentValue = getMetricValue(currentItem, metric);
  const previousValue = getMetricValue(
    {
      activityScore: Number(reference.score) || 0,
      weeklyExperience: Number(reference.gexp) || 0,
      chat30d: Number(reference.chat_30d) || 0,
      playtime30dSeconds: Number(reference.playtime_30d) || 0
    },
    metric
  );

  const gain = currentValue - previousValue;
  return Number(gain.toFixed(2));
}

class LeaderboardService {
  constructor() {
    this.state = null;
  }

  getDefaultState() {
    return {
      version: 1,
      channelId: null,
      messageId: null,
      metric: "score",
      top: getLeaderboardConfig().defaultTop,
      lastSnapshot: null,
      snapshots: [],
      updatedAt: null
    };
  }

  ensureDataFile() {
    if (!existsSync("data")) {
      mkdirSync("data", { recursive: true });
    }

    if (!existsSync(STATE_PATH)) {
      writeFileSync(STATE_PATH, JSON.stringify(this.getDefaultState(), null, 2));
    }
  }

  loadState() {
    if (this.state) {
      return this.state;
    }

    this.ensureDataFile();

    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
      const state = {
        ...this.getDefaultState(),
        ...(parsed && typeof parsed === "object" ? parsed : {})
      };
      state.snapshots = Array.isArray(state.snapshots) ? state.snapshots : [];
      this.state = state;
    } catch {
      this.state = this.getDefaultState();
      this.saveState();
    }

    return this.state;
  }

  saveState() {
    const state = this.loadState();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  }

  setBinding({ channelId, messageId, metric, top }) {
    const state = this.loadState();
    state.channelId = channelId || null;
    state.messageId = messageId || null;
    if (metric) {
      state.metric = metric;
    }

    if (Number.isFinite(top)) {
      state.top = top;
    }

    state.updatedAt = Date.now();
    this.saveState();
    return state;
  }

  getBinding() {
    const state = this.loadState();
    return {
      channelId: state.channelId,
      messageId: state.messageId,
      metric: state.metric,
      top: state.top
    };
  }

  pruneSnapshots(nowTs = Date.now()) {
    const state = this.loadState();
    state.snapshots = state.snapshots.filter((snapshot) => Number.isFinite(snapshot?.ts) && snapshot.ts >= nowTs - SNAPSHOT_KEEP_MS);
  }

  async buildMembers(nowTs = Date.now()) {
    const guildData = await hypixel.getGuild("player", bot.username, { noCaching: true, noCacheCheck: true });
    const guildMembers = guildData?.members || [];
    const settings = getLeaderboardConfig();

    const members = await runWithConcurrency(guildMembers, settings.apiConcurrency, async (member) => {
      let player = null;
      try {
        player = await hypixel.getPlayer(member.uuid, { guild: false });
      } catch {
        player = null;
      }

      const trackerSnapshot = activityTracker.getActivitySnapshot(member.uuid, nowTs);
      const lastLoginTs = normalizeTimestamp(player?.lastLogin) ?? normalizeTimestamp(trackerSnapshot.lastSeenTs);
      const daysSinceActivity = getDaysSince(lastLoginTs, nowTs);

      return {
        uuid: member.uuid,
        username: player?.nickname || member.uuid,
        weeklyExperience: Number(member.weeklyExperience) || 0,
        chat30d: Number(trackerSnapshot.chat30dCount) || 0,
        playtime30dSeconds: Number(trackerSnapshot.playtime30dSeconds) || 0,
        lastActivityTs: lastLoginTs,
        daysSinceActivity
      };
    });

    return computeActivityScores(members);
  }

  createSnapshot(metric, members, nowTs = Date.now()) {
    return {
      ts: nowTs,
      metric,
      members: Object.fromEntries(
        members.map((item) => [
          item.uuid,
          {
            score: item.activityScore,
            gexp: item.weeklyExperience,
            chat_30d: item.chat30d,
            playtime_30d: item.playtime30dSeconds
          }
        ])
      )
    };
  }

  buildEmbed({ metric, top, members, referenceSnapshot, nowTs = Date.now() }) {
    const sorted = sortLeaderboard(members, metric);
    const selected = sorted.slice(0, top);
    const topThree = selected.slice(0, 3);
    const rest = selected.slice(3);
    const medals = ["🥇", "🥈", "🥉"];

    const topThreeBlock =
      topThree.length === 0
        ? "No members found."
        : topThree
            .map((item, index) => {
              const gain = computeGain(item, referenceSnapshot, metric);
              return `${medals[index]} **${item.username}** — \`${formatMetricValue(metric, getMetricValue(item, metric))}\` ${getTrendLabel(gain, metric)}\n⭐ ${compactNumber(
                item.weeklyExperience
              )} • ⏱ ${formatDuration(item.playtime30dSeconds)}`;
            })
            .join("\n\n");

    const restFields = chunk(rest, 7).map((group, groupIndex) => {
      const startRank = 4 + groupIndex * 7;
      const endRank = startRank + group.length - 1;
      const value = group
        .map((item, index) => {
          const rank = startRank + index;
          return `\`${rank}.\` **${item.username}** \`${formatMetricValue(metric, getMetricValue(item, metric))}\``;
        })
        .join("\n");

      return {
        name: `Rankings ${startRank}-${endRank}`,
        value: value || "No data",
        inline: false
      };
    });

    const refText = referenceSnapshot?.ts ? `<t:${Math.floor(referenceSnapshot.ts / 1000)}:R>` : "not enough history";
    const metricLabel = getMetricLabel(metric);
    const updated = new Date(nowTs).toUTCString().replace(" GMT", " UTC");

    const embed = new Embed().setColor(0xf1c40f).setTitle("🏆 Guild Leaderboard").setDescription(topThreeBlock);

    if (restFields.length > 0) {
      embed.addFields(...restFields);
    }

    embed.addFields({
      name: "Meta",
      value: `Metric: ${metricLabel} • Top ${top} • 24h window (${refText})\nUpdated: ${updated}`,
      inline: false
    });

    return embed;
  }

  async buildLeaderboard({ metric, top, persistSnapshot = false }) {
    const settings = getLeaderboardConfig();
    const safeMetric = ["score", "gexp", "chat_30d", "playtime_30d"].includes(metric) ? metric : settings.defaultMetric;
    const safeTop = Math.max(1, Math.min(Number(top) || settings.defaultTop, settings.maxTop));
    const nowTs = Date.now();

    const members = await this.buildMembers(nowTs);
    const state = this.loadState();
    this.pruneSnapshots(nowTs);

    const referenceSnapshot = findReferenceSnapshot(state.snapshots, nowTs);
    const embed = this.buildEmbed({ metric: safeMetric, top: safeTop, members, referenceSnapshot, nowTs });

    if (persistSnapshot) {
      const snapshot = this.createSnapshot(safeMetric, members, nowTs);
      state.snapshots.push(snapshot);
      state.lastSnapshot = snapshot;
      state.metric = safeMetric;
      state.top = safeTop;
      state.updatedAt = nowTs;
      this.pruneSnapshots(nowTs);
      this.saveState();
    }

    return {
      embed,
      metric: safeMetric,
      top: safeTop,
      nowTs
    };
  }

  async updateConfiguredMessage() {
    const state = this.loadState();
    if (!state.channelId) {
      return { skipped: true, reason: "no_channel" };
    }

    const { embed, metric, top } = await this.buildLeaderboard({
      metric: state.metric,
      top: state.top,
      persistSnapshot: true
    });

    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") {
      console.warn("Leaderboard channel not found. Run /leaderboard setup:true again.");
      return { skipped: true, reason: "invalid_channel" };
    }

    let message = null;
    if (state.messageId && channel.messages?.fetch) {
      message = await channel.messages.fetch(state.messageId).catch(() => null);
    }

    if (message) {
      await message.edit({ embeds: [embed] });
    } else {
      message = await channel.send({ embeds: [embed] });
      state.messageId = message.id;
    }

    state.metric = metric;
    state.top = top;
    state.updatedAt = Date.now();
    this.saveState();

    return { updated: true, messageId: state.messageId };
  }
}

const leaderboardService = new LeaderboardService();

module.exports = leaderboardService;
module.exports._private = {
  computeActivityScores,
  sortLeaderboard,
  getMetricValue,
  computeGain,
  findReferenceSnapshot,
  formatMetricValue,
  compactNumber
};
