/* eslint-env jest */

const { evaluateRoast } = require("../src/minecraft/other/roastEngine.js");

function makeStats(overrides = {}) {
  return {
    skills: {
      combat: { levelWithProgress: 60 },
      mining: { levelWithProgress: 24 },
      farming: { levelWithProgress: 22 },
      alchemy: { levelWithProgress: 15 },
      enchanting: { levelWithProgress: 18 }
    },
    skillAverage: 28,
    sbLevel: 230,
    networth: 6500000000,
    networthFormatted: "6.50B",
    cataLevel: 38,
    inactiveDays: 9,
    ...overrides
  };
}

describe("roastEngine v3", () => {
  test("returns structured setup->main->closer text", () => {
    const result = evaluateRoast({ stats: makeStats(), username: "Jamesien", isSelf: false, rng: () => 0 });
    const parts = result.message.split(" ");
    expect(parts.length).toBeGreaterThan(6);
    expect(result.classification).toBe("SKILL_ISSUE");
  });

  test("limits findings to top 2", () => {
    const result = evaluateRoast({ stats: makeStats(), username: "Jamesien", isSelf: false, rng: () => 0.2 });
    expect(result.findings.length).toBeLessThanOrEqual(2);
  });

  test("self roast starts with self-intro lines", () => {
    const result = evaluateRoast({ stats: makeStats(), username: "Jamesien", isSelf: true, rng: () => 0 });
    expect(result.message.toLowerCase()).toContain("you asked for this");
  });

  test("combo path is selected when combo rules trigger", () => {
    const result = evaluateRoast({
      stats: makeStats({
        networth: 9000000000,
        skillAverage: 24,
        skills: {
          combat: { levelWithProgress: 60 },
          mining: { levelWithProgress: 20 },
          farming: { levelWithProgress: 20 },
          alchemy: { levelWithProgress: 22 },
          enchanting: { levelWithProgress: 22 }
        }
      }),
      username: "Jamesien",
      isSelf: false,
      rng: () => 0
    });

    expect(result.comboKey).toBeDefined();
  });

  test("new player path returns protected classification", () => {
    const result = evaluateRoast({
      stats: makeStats({ sbLevel: 20, skillAverage: 12, networth: 20000000, networthFormatted: "20M" }),
      username: "Newbie",
      isSelf: false,
      rng: () => 0
    });

    expect(result.classification).toBe("NEW_PLAYER_PROTECTED");
    expect(result.message.toLowerCase()).toContain("early game");
  });

  test("no-issue path is sarcastic", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 40 },
          mining: { levelWithProgress: 41 },
          farming: { levelWithProgress: 40 },
          alchemy: { levelWithProgress: 35 },
          enchanting: { levelWithProgress: 36 }
        },
        skillAverage: 41,
        sbLevel: 180,
        networth: 2000000000,
        networthFormatted: "2B",
        cataLevel: 25,
        inactiveDays: 2
      }),
      username: "BalancedGuy",
      isSelf: false,
      rng: () => 0
    });

    expect(result.classification).toBe("NO_ISSUE");
    expect(result.message.toLowerCase()).toContain("annoyingly balanced");
  });

  test("nuke line can trigger with severe finding", () => {
    const result = evaluateRoast({
      stats: makeStats(),
      username: "Jamesien",
      isSelf: false,
      rng: () => 0
    });

    expect(result.message.toLowerCase()).toContain("why");
  });

  test("quality filter falls back on single mild finding", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 50 },
          mining: { levelWithProgress: 34 },
          farming: { levelWithProgress: 40 },
          alchemy: { levelWithProgress: 30 },
          enchanting: { levelWithProgress: 30 }
        },
        skillAverage: 36,
        sbLevel: 150,
        networth: 1200000000,
        networthFormatted: "1.2B",
        cataLevel: 20,
        inactiveDays: 1
      }),
      username: "MidGuy",
      isSelf: false,
      rng: () => 0
    });

    expect(result.findings.length).toBe(1);
    expect(result.findings[0].severity).toBe("mild");
    expect(result.message.toLowerCase()).toContain("skill issue");
  });

  test("minGap thresholds suppress weak gaps when raised", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 60 },
          mining: { levelWithProgress: 40 },
          farming: { levelWithProgress: 40 },
          alchemy: { levelWithProgress: 35 },
          enchanting: { levelWithProgress: 35 }
        },
        skillAverage: 42,
        sbLevel: 200,
        networth: 3000000000,
        networthFormatted: "3B",
        cataLevel: 20,
        inactiveDays: 1
      }),
      username: "GapGuy",
      isSelf: false,
      configRoast: {
        minGaps: {
          combatMiningGap: 30,
          combatFarmingGap: 30,
          oneTrickGap: 30
        }
      },
      rng: () => 0
    });

    expect(result.classification).toBe("NO_ISSUE");
  });

  test("generic combo fallback is used when combo has no template", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 40 },
          mining: { levelWithProgress: 40 },
          farming: { levelWithProgress: 40 },
          alchemy: { levelWithProgress: 10 },
          enchanting: { levelWithProgress: 12 }
        },
        skillAverage: 35,
        networth: 2000000000,
        networthFormatted: "2B",
        sbLevel: 210,
        cataLevel: 20,
        inactiveDays: 10
      }),
      username: "ComboGuy",
      isSelf: false,
      rng: () => 0.2
    });

    expect(result.comboKey).toBe("activity_shame+fake_late_game");
    expect(result.message.toLowerCase()).toContain("stacked");
  });
});
