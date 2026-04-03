/* eslint-env jest */

jest.mock("axios", () => ({
  get: jest.fn(async () => ({ data: [] }))
}));

const { _private } = require("../src/minecraft/other/eventNotifier.js");

describe("event notifier dedupe/timing", () => {
  test("fires live event once across consecutive polls", async () => {
    const messages = [];
    const cache = new Map();
    const now = 100000;
    const start = now + 2000;

    const events = {
      DARK_AUCTION: {
        name: "Dark Auction",
        events: [{ start_timestamp: start }]
      }
    };

    await _private.runNotifierTick({
      now,
      previousTick: now - 5000,
      events,
      notifiers: { DARK_AUCTION: true },
      customTime: {},
      sendMessage: (message) => messages.push(message),
      wait: async () => {},
      sendThrottleMs: 0,
      cache
    });

    await _private.runNotifierTick({
      now: now + 6000,
      previousTick: now,
      events,
      notifiers: { DARK_AUCTION: true },
      customTime: {},
      sendMessage: (message) => messages.push(message),
      wait: async () => {},
      sendThrottleMs: 0,
      cache
    });

    expect(messages.filter((msg) => msg.includes("LIVE NOW"))).toHaveLength(1);
  });

  test("fires upcoming custom-time once per target", async () => {
    const messages = [];
    const cache = new Map();
    const now = 1000000;
    const start = now + 2 * 60 * 1000;

    const events = {
      DARK_AUCTION: {
        name: "Dark Auction",
        events: [{ start_timestamp: start }]
      }
    };

    await _private.runNotifierTick({
      now: now + 1000,
      previousTick: now - 1000,
      events,
      notifiers: { DARK_AUCTION: true },
      customTime: { "2": ["DARK_AUCTION"] },
      sendMessage: (message) => messages.push(message),
      wait: async () => {},
      sendThrottleMs: 0,
      cache
    });

    await _private.runNotifierTick({
      now: now + 4000,
      previousTick: now + 1000,
      events,
      notifiers: { DARK_AUCTION: true },
      customTime: { "2": ["DARK_AUCTION"] },
      sendMessage: (message) => messages.push(message),
      wait: async () => {},
      sendThrottleMs: 0,
      cache
    });

    expect(messages.filter((msg) => msg.includes("Upcoming Event"))).toHaveLength(1);
  });

  test("lag spike does not backfill stale targets", async () => {
    const messages = [];
    const cache = new Map();
    const now = 200000;
    const start = now - 60000;

    const events = {
      DARK_AUCTION: {
        name: "Dark Auction",
        events: [{ start_timestamp: start }]
      }
    };

    await _private.runNotifierTick({
      now,
      previousTick: now - 300000,
      events,
      notifiers: { DARK_AUCTION: true },
      customTime: { "2": ["DARK_AUCTION"] },
      sendMessage: (message) => messages.push(message),
      wait: async () => {},
      sendThrottleMs: 0,
      cache
    });

    expect(messages).toHaveLength(0);
  });

  test("dedupe key includes event type version", () => {
    const key = _private.buildDedupeKey({
      eventKey: "DARK_AUCTION",
      startTs: 1234,
      phase: "live",
      target: "live",
      eventTypeVersions: { DARK_AUCTION: 9 }
    });

    expect(key).toBe("v2:DARK_AUCTION:9:1234:live:live");
  });

  test("cleanup removes old entries", () => {
    const cache = new Map();
    cache.set("old", 1000);
    cache.set("new", 8001);

    _private.cleanupDedupeCache(cache, 10000, 3000);
    expect(cache.has("old")).toBe(false);
    expect(cache.has("new")).toBe(true);
  });
});
