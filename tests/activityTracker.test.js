/* eslint-env jest */
const tracker = require("../src/discord/other/activityTracker.js");

describe("activityTracker", () => {
  beforeEach(() => {
    tracker._resetForTests();
  });

  afterEach(() => {
    tracker._resetForTests();
  });

  test("accumulates login/logout playtime", () => {
    const start = Date.UTC(2026, 2, 1, 10, 0, 0);
    const end = Date.UTC(2026, 2, 1, 11, 0, 0);

    tracker.recordLogin("uuid-1", start);
    tracker.recordLogout("uuid-1", end);

    const snapshot = tracker.getActivitySnapshot("uuid-1", end);
    expect(snapshot.playtime30dSeconds).toBe(3600);
    expect(snapshot.lastSeenTs).toBe(end);
  });

  test("counts open session in snapshot", () => {
    const start = Date.UTC(2026, 2, 2, 10, 0, 0);
    const now = Date.UTC(2026, 2, 2, 10, 30, 0);

    tracker.recordLogin("uuid-2", start);
    const snapshot = tracker.getActivitySnapshot("uuid-2", now);

    expect(snapshot.playtime30dSeconds).toBe(1800);
    expect(snapshot.openSessionStartTs).toBe(start);
  });

  test("prunes activity older than 30 days", () => {
    const now = Date.UTC(2026, 2, 24, 12, 0, 0);
    const old = now - 31 * 24 * 60 * 60 * 1000;

    tracker.recordChat("uuid-3", old);
    tracker.recordChat("uuid-3", now);

    const snapshot = tracker.getActivitySnapshot("uuid-3", now);
    expect(snapshot.chat30dCount).toBe(1);
  });
});
