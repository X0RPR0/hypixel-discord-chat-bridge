/* eslint-env jest */

jest.mock("../src/contracts/API/HypixelRebornAPI.js", () => ({
  getGuild: jest.fn(),
  getPlayer: jest.fn()
}));

const service = require("../src/discord/other/leaderboardService.js");

describe("leaderboardService helpers", () => {
  const { computeActivityScores, sortLeaderboard, getMetricValue, computeGain, findReferenceSnapshot } = service._private;

  test("computes deterministic activity scores", () => {
    const input = [
      { uuid: "a", username: "A", weeklyExperience: 1000, chat30d: 50, playtime30dSeconds: 3600, daysSinceActivity: 1 },
      { uuid: "b", username: "B", weeklyExperience: 500, chat30d: 10, playtime30dSeconds: 1800, daysSinceActivity: 10 }
    ];

    const output = computeActivityScores(input);
    expect(output).toHaveLength(2);
    expect(output[0].activityScore).toBeGreaterThan(output[1].activityScore);
  });

  test("sorts by selected metric with tie-breakers", () => {
    const input = [
      { username: "Zed", weeklyExperience: 100, activityScore: 50, chat30d: 2, playtime30dSeconds: 100 },
      { username: "Amy", weeklyExperience: 150, activityScore: 50, chat30d: 1, playtime30dSeconds: 90 },
      { username: "Bob", weeklyExperience: 120, activityScore: 60, chat30d: 5, playtime30dSeconds: 200 }
    ];

    const sorted = sortLeaderboard(input, "score");
    expect(sorted.map((item) => item.username)).toEqual(["Bob", "Amy", "Zed"]);
  });

  test("computes gain from 24h reference snapshot", () => {
    const referenceSnapshot = {
      ts: Date.UTC(2026, 2, 23, 10, 0, 0),
      members: {
        u1: { score: 42, gexp: 1000, chat_30d: 30, playtime_30d: 4000 }
      }
    };

    const current = {
      uuid: "u1",
      activityScore: 50,
      weeklyExperience: 1100,
      chat30d: 35,
      playtime30dSeconds: 4300
    };

    expect(computeGain(current, referenceSnapshot, "score")).toBe(8);
    expect(computeGain(current, referenceSnapshot, "gexp")).toBe(100);
    expect(computeGain(current, referenceSnapshot, "chat_30d")).toBe(5);
    expect(computeGain(current, referenceSnapshot, "playtime_30d")).toBe(300);
  });

  test("findReferenceSnapshot returns closest around 24h", () => {
    const now = Date.UTC(2026, 2, 24, 12, 0, 0);
    const snapshots = [
      { ts: now - 6 * 60 * 60 * 1000 },
      { ts: now - 24 * 60 * 60 * 1000 + 20 * 60 * 1000 },
      { ts: now - 30 * 60 * 60 * 1000 }
    ];

    const selected = findReferenceSnapshot(snapshots, now);
    expect(selected.ts).toBe(snapshots[1].ts);
  });

  test("metric value helper returns expected source field", () => {
    const item = { activityScore: 12.5, weeklyExperience: 400, chat30d: 10, playtime30dSeconds: 800 };
    expect(getMetricValue(item, "score")).toBe(12.5);
    expect(getMetricValue(item, "gexp")).toBe(400);
    expect(getMetricValue(item, "chat_30d")).toBe(10);
    expect(getMetricValue(item, "playtime_30d")).toBe(800);
  });
});
