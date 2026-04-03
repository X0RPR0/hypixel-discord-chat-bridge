const { getSkyblockCalendar } = require("../../../API/functions/getCalendar.js");
const minecraftCommand = require("../../contracts/minecraftCommand.js");
const config = require("../../../config.json");
const axios = require("axios");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POLL_MS = 5000;
const SEND_THROTTLE_MS = 1500;
const LIVE_WINDOW_MS = 10000;
const CATCHUP_MAX_MS = 15000;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

const EVENT_TYPE_VERSIONS = Object.freeze({
  BANK_INTEREST: 1,
  DARK_AUCTION: 1,
  ELECTION_BOOTH_OPENS: 1,
  ELECTION_OVER: 1,
  FALLEN_STAR_CULT: 1,
  FEAR_MONGERER: 1,
  JACOBS_CONTEST: 1,
  JERRYS_WORKSHOP: 1,
  NEW_YEAR_CELEBRATION: 1,
  SEASON_OF_JERRY: 1,
  SPOOKY_FESTIVAL: 1,
  TRAVELING_ZOO: 1,
  HOPPITY_HUNT: 1
});

const dedupeCache = new Map();
let lastTickAt = Date.now();
let tickRunning = false;

function getLeadMinutesForEvent(customTime, eventKey) {
  if (!customTime || !eventKey) {
    return [];
  }

  return Object.keys(customTime)
    .filter((minute) => Array.isArray(customTime[minute]) && customTime[minute].includes(eventKey))
    .map((minute) => Number.parseInt(minute, 10))
    .filter((minute) => Number.isFinite(minute) && minute >= 0)
    .sort((a, b) => a - b);
}

function getEffectiveLastTick(previousTick, now, catchupMaxMs = CATCHUP_MAX_MS) {
  return Math.max(previousTick, now - catchupMaxMs);
}

function crossedTarget(previousTick, now, targetTs) {
  return previousTick < targetTs && now >= targetTs;
}

function buildDedupeKey({ eventKey, startTs, phase, target, eventTypeVersions = EVENT_TYPE_VERSIONS }) {
  const version = eventTypeVersions[eventKey] || 1;
  return `v2:${eventKey}:${version}:${startTs}:${phase}:${target}`;
}

function cleanupDedupeCache(cache = dedupeCache, now = Date.now(), ttlMs = DEDUPE_TTL_MS) {
  for (const [key, createdAt] of cache.entries()) {
    if (now - createdAt > ttlMs) {
      cache.delete(key);
    }
  }
}

function markSentIfNew(cache, key, now = Date.now()) {
  if (cache.has(key)) {
    return false;
  }

  cache.set(key, now);
  return true;
}

async function getEventExtraInfo(eventKey, startTimestamp, jacobCache) {
  if (eventKey !== "JACOBS_CONTEST") {
    return "";
  }

  const targetSecond = Math.floor(startTimestamp / 1000);
  if (jacobCache.has(targetSecond)) {
    return jacobCache.get(targetSecond);
  }

  try {
    const { data: jacobResponse } = await axios.get("https://dawjaw.net/jacobs");
    const jacobCrops = jacobResponse.find((crop) => crop.time >= targetSecond);
    const extra = jacobCrops?.crops !== undefined ? ` (${jacobCrops.crops.join(", ")})` : "";
    jacobCache.set(targetSecond, extra);
    return extra;
  } catch {
    jacobCache.set(targetSecond, "");
    return "";
  }
}

async function runNotifierTick({
  now,
  previousTick,
  events,
  notifiers,
  customTime,
  sendMessage,
  wait = delay,
  sendThrottleMs = SEND_THROTTLE_MS,
  cache = dedupeCache,
  eventTypeVersions = EVENT_TYPE_VERSIONS
}) {
  const effectivePreviousTick = getEffectiveLastTick(previousTick, now);
  const notifications = [];

  for (const eventKey of Object.keys(events || {})) {
    const eventData = events[eventKey];
    if (!eventData || !Array.isArray(eventData.events) || eventData.events.length === 0) {
      continue;
    }

    if (notifiers?.[eventKey] === false) {
      continue;
    }

    const nextStart = Number(eventData.events[0].start_timestamp);
    if (!Number.isFinite(nextStart)) {
      continue;
    }

    const leadMinutes = getLeadMinutesForEvent(customTime, eventKey);
    for (const minute of leadMinutes) {
      const target = nextStart - minute * 60 * 1000;
      if (!crossedTarget(effectivePreviousTick, now, target)) {
        continue;
      }

      const key = buildDedupeKey({
        eventKey,
        startTs: nextStart,
        phase: "upcoming",
        target: minute,
        eventTypeVersions
      });

      if (!markSentIfNew(cache, key, now)) {
        continue;
      }

      notifications.push({
        eventKey,
        eventName: eventData.name,
        startTs: nextStart,
        phase: "upcoming"
      });
    }

    if (crossedTarget(effectivePreviousTick, now, nextStart) && now - nextStart <= LIVE_WINDOW_MS) {
      const key = buildDedupeKey({
        eventKey,
        startTs: nextStart,
        phase: "live",
        target: "live",
        eventTypeVersions
      });

      if (markSentIfNew(cache, key, now)) {
        notifications.push({
          eventKey,
          eventName: eventData.name,
          startTs: nextStart,
          phase: "live"
        });
      }
    }
  }

  const jacobCache = new Map();
  for (const notification of notifications) {
    const extraInfo = await getEventExtraInfo(notification.eventKey, notification.startTs, jacobCache);

    if (notification.phase === "upcoming") {
      const minutes = Math.max(0, Math.floor((notification.startTs - now) / 1000 / 60));
      sendMessage(`[EVENT] Upcoming Event → ${notification.eventName}${extraInfo} (starts in ${minutes}m)`);
    } else {
      sendMessage(`[EVENT] LIVE NOW → ${notification.eventName}${extraInfo}`);
    }

    await wait(sendThrottleMs);
  }

  cleanupDedupeCache(cache, now);
}

function startNotifier() {
  if (!config.minecraft.skyblockEventsNotifications.enabled || process.env.NODE_ENV === "test") {
    return;
  }

  const { notifiers, customTime } = config.minecraft.skyblockEventsNotifications;

  setInterval(async () => {
    if (tickRunning) {
      return;
    }

    tickRunning = true;
    try {
      const eventBOT = new minecraftCommand(bot);
      eventBOT.officer = false;
      const calendar = getSkyblockCalendar();
      if (!calendar || !calendar.events) {
        return;
      }

      const now = Date.now();
      await runNotifierTick({
        now,
        previousTick: lastTickAt,
        events: calendar.events,
        notifiers,
        customTime,
        sendMessage: (message) => eventBOT.send(message),
        cache: dedupeCache,
        eventTypeVersions: EVENT_TYPE_VERSIONS
      });

      lastTickAt = now;
    } catch (e) {
      console.error(e);
    } finally {
      tickRunning = false;
    }
  }, POLL_MS);
}

startNotifier();

module.exports = {
  _private: {
    POLL_MS,
    LIVE_WINDOW_MS,
    CATCHUP_MAX_MS,
    DEDUPE_TTL_MS,
    EVENT_TYPE_VERSIONS,
    dedupeCache,
    getLeadMinutesForEvent,
    getEffectiveLastTick,
    crossedTarget,
    buildDedupeKey,
    cleanupDedupeCache,
    markSentIfNew,
    runNotifierTick
  }
};
