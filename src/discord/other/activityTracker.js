const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");

const DATA_PATH = "data/activityTracker.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

class ActivityTracker {
  constructor() {
    this.state = null;
    this.saveTimer = null;
  }

  ensureLoaded() {
    if (this.state) {
      return;
    }

    this.ensureDataFile();

    try {
      const raw = readFileSync(DATA_PATH, "utf8");
      const parsed = JSON.parse(raw);
      this.state = this.normalizeState(parsed);
    } catch {
      this.state = this.getDefaultState();
      this.saveNow();
    }
  }

  ensureDataFile() {
    if (!existsSync("data")) {
      mkdirSync("data", { recursive: true });
    }

    if (!existsSync(DATA_PATH)) {
      writeFileSync(DATA_PATH, JSON.stringify(this.getDefaultState(), null, 2));
    }
  }

  getDefaultState() {
    return {
      version: 1,
      users: {}
    };
  }

  normalizeState(state) {
    if (!state || typeof state !== "object") {
      return this.getDefaultState();
    }

    const users = state.users && typeof state.users === "object" ? state.users : {};
    const normalizedUsers = {};

    for (const [uuid, value] of Object.entries(users)) {
      normalizedUsers[uuid] = this.normalizeUser(value);
    }

    return {
      version: 1,
      users: normalizedUsers
    };
  }

  normalizeUser(user) {
    return {
      lastSeenTs: this.toNullableNumber(user?.lastSeenTs),
      openSessionStartTs: this.toNullableNumber(user?.openSessionStartTs),
      playtimeSecondsByDay: this.normalizeNumberMap(user?.playtimeSecondsByDay),
      chatCountByDay: this.normalizeNumberMap(user?.chatCountByDay)
    };
  }

  toNullableNumber(value) {
    return Number.isFinite(value) ? value : null;
  }

  normalizeNumberMap(map) {
    if (!map || typeof map !== "object") {
      return {};
    }

    const normalized = {};
    for (const [key, value] of Object.entries(map)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        continue;
      }

      normalized[key] = number;
    }

    return normalized;
  }

  getUser(uuid) {
    this.ensureLoaded();

    if (!this.state.users[uuid]) {
      this.state.users[uuid] = this.normalizeUser({});
    }

    return this.state.users[uuid];
  }

  scheduleSave() {
    if (this.saveTimer) {
      return;
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 500);

    if (typeof this.saveTimer.unref === "function") {
      this.saveTimer.unref();
    }
  }

  saveNow() {
    this.ensureLoaded();
    writeFileSync(DATA_PATH, JSON.stringify(this.state, null, 2));
  }

  getDayKey(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  getDayStart(timestamp) {
    const date = new Date(timestamp);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }

  incrementMap(map, key, amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    map[key] = (map[key] || 0) + amount;
  }

  addDurationAcrossDays(map, startTs, endTs) {
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
      return;
    }

    let cursor = startTs;
    while (cursor < endTs) {
      const dayStart = this.getDayStart(cursor);
      const dayEnd = dayStart + DAY_MS;
      const segmentEnd = Math.min(dayEnd, endTs);
      const durationSeconds = Math.max(0, Math.floor((segmentEnd - cursor) / 1000));
      const dayKey = this.getDayKey(cursor);
      this.incrementMap(map, dayKey, durationSeconds);
      cursor = segmentEnd;
    }
  }

  pruneUser(user, nowTs = Date.now()) {
    const cutoffDayStart = this.getDayStart(nowTs - THIRTY_DAYS_MS);

    const pruneMap = (map) => {
      for (const key of Object.keys(map)) {
        const keyTs = new Date(`${key}T00:00:00.000Z`).getTime();
        if (!Number.isFinite(keyTs) || keyTs < cutoffDayStart) {
          delete map[key];
        }
      }
    };

    pruneMap(user.playtimeSecondsByDay);
    pruneMap(user.chatCountByDay);
  }

  recordLogin(uuid, nowTs = Date.now()) {
    if (!uuid) {
      return;
    }

    const user = this.getUser(uuid);
    this.pruneUser(user, nowTs);

    user.lastSeenTs = nowTs;
    if (!Number.isFinite(user.openSessionStartTs)) {
      user.openSessionStartTs = nowTs;
    }

    this.scheduleSave();
  }

  recordLogout(uuid, nowTs = Date.now()) {
    if (!uuid) {
      return;
    }

    const user = this.getUser(uuid);
    this.pruneUser(user, nowTs);

    if (Number.isFinite(user.openSessionStartTs)) {
      this.addDurationAcrossDays(user.playtimeSecondsByDay, user.openSessionStartTs, nowTs);
    }

    user.lastSeenTs = nowTs;
    user.openSessionStartTs = null;

    this.scheduleSave();
  }

  recordChat(uuid, nowTs = Date.now()) {
    if (!uuid) {
      return;
    }

    const user = this.getUser(uuid);
    this.pruneUser(user, nowTs);

    const dayKey = this.getDayKey(nowTs);
    this.incrementMap(user.chatCountByDay, dayKey, 1);

    user.lastSeenTs = nowTs;

    this.scheduleSave();
  }

  getRollingSum(map, nowTs = Date.now()) {
    const cutoffDayStart = this.getDayStart(nowTs - THIRTY_DAYS_MS);
    let total = 0;

    for (const [key, value] of Object.entries(map || {})) {
      const keyTs = new Date(`${key}T00:00:00.000Z`).getTime();
      if (!Number.isFinite(keyTs) || keyTs < cutoffDayStart) {
        continue;
      }

      total += Number(value) || 0;
    }

    return total;
  }

  getActivitySnapshot(uuid, nowTs = Date.now()) {
    if (!uuid) {
      return {
        lastSeenTs: null,
        playtime30dSeconds: 0,
        chat30dCount: 0,
        openSessionStartTs: null
      };
    }

    const user = this.getUser(uuid);
    this.pruneUser(user, nowTs);

    let playtime30dSeconds = this.getRollingSum(user.playtimeSecondsByDay, nowTs);
    if (Number.isFinite(user.openSessionStartTs)) {
      const openSessionSeconds = Math.max(0, Math.floor((nowTs - user.openSessionStartTs) / 1000));
      playtime30dSeconds += openSessionSeconds;
    }

    const chat30dCount = this.getRollingSum(user.chatCountByDay, nowTs);

    return {
      lastSeenTs: this.toNullableNumber(user.lastSeenTs),
      playtime30dSeconds,
      chat30dCount,
      openSessionStartTs: this.toNullableNumber(user.openSessionStartTs)
    };
  }

  _resetForTests() {
    this.state = this.getDefaultState();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}

module.exports = new ActivityTracker();
