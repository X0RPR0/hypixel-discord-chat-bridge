/* eslint-env jest */

const { evaluateRoast, _private } = require("../src/minecraft/other/roastEngine.js");

function makeStats(overrides = {}) {
  return {
    skills: {
      combat: { levelWithProgress: 60 },
      mining: { levelWithProgress: 24 },
      farming: { levelWithProgress: 22 },
      fishing: { levelWithProgress: 30 },
      foraging: { levelWithProgress: 20 },
      alchemy: { levelWithProgress: 15 },
      enchanting: { levelWithProgress: 18 },
      taming: { levelWithProgress: 18 },
      carpentry: { levelWithProgress: 12 }
    },
    skillAverage: 28,
    sbLevel: 230,
    networth: 6500000000,
    networthFormatted: "6.50B",
    cataLevel: 38,
    slayerTotal: 24,
    inactiveDays: 9,
    inventoryApiOff: false,
    ...overrides
  };
}

describe("roastEngine stage matrix v4", () => {
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

  test("bracket resolver routes boundaries correctly", () => {
    expect(_private.resolveStagePack(99).key).toBe("lt100");
    expect(_private.resolveStagePack(100).key).toBe("100_199");
    expect(_private.resolveStagePack(199).key).toBe("100_199");
    expect(_private.resolveStagePack(200).key).toBe("200_299");
    expect(_private.resolveStagePack(299).key).toBe("200_299");
    expect(_private.resolveStagePack(300).key).toBe("300_399");
    expect(_private.resolveStagePack(399).key).toBe("300_399");
    expect(_private.resolveStagePack(400).key).toBe("400_500");
    expect(_private.resolveStagePack(500).key).toBe("400_500");
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

  test("balanced midgame still gets blame via stage/ceiling pressure", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 45 },
          mining: { levelWithProgress: 46 },
          farming: { levelWithProgress: 45 },
          fishing: { levelWithProgress: 44 },
          foraging: { levelWithProgress: 44 },
          enchanting: { levelWithProgress: 42 },
          alchemy: { levelWithProgress: 40 },
          taming: { levelWithProgress: 42 },
          carpentry: { levelWithProgress: 40 }
        },
        skillAverage: 44,
        sbLevel: 180,
        networth: 4000000000,
        networthFormatted: "4B",
        cataLevel: 32,
        slayerTotal: 30,
        inactiveDays: 0
      }),
      username: "BalancedGuy",
      isSelf: false,
      rng: () => 0.1
    });

    expect(result.classification).toBe("SKILL_ISSUE");
  });

  test("no-issue still possible in rare low bracket case", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 25 },
          mining: { levelWithProgress: 24 },
          farming: { levelWithProgress: 24 },
          fishing: { levelWithProgress: 23 },
          foraging: { levelWithProgress: 23 },
          enchanting: { levelWithProgress: 18 },
          alchemy: { levelWithProgress: 18 },
          taming: { levelWithProgress: 20 },
          carpentry: { levelWithProgress: 16 }
        },
        skillAverage: 24,
        sbLevel: 90,
        networth: 180000000,
        networthFormatted: "180M",
        cataLevel: 10,
        slayerTotal: 12,
        inactiveDays: 1
      }),
      username: "LowBalanced",
      isSelf: false,
      rng: () => 0
    });

    expect(result.classification).toBe("NO_ISSUE");
    expect(result.message.toLowerCase()).toContain("annoyingly balanced");
  });

  test("combo path is selected when stage combo rules trigger", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skillAverage: 26,
        sbLevel: 210,
        cataLevel: 18,
        slayerTotal: 10
      }),
      username: "ComboGuy",
      isSelf: false,
      rng: () => 0
    });

    expect(result.comboKey).toBe("stage_core_floor+stage_sa_floor");
  });

  test("stage combo uses dedicated template instead of generic stacked fallback", () => {
    const result = evaluateRoast({
      stats: makeStats({
        skills: {
          combat: { levelWithProgress: 36 },
          mining: { levelWithProgress: 28 },
          farming: { levelWithProgress: 20 },
          fishing: { levelWithProgress: 46 },
          foraging: { levelWithProgress: 24 },
          alchemy: { levelWithProgress: 16 },
          enchanting: { levelWithProgress: 38 },
          taming: { levelWithProgress: 24 },
          carpentry: { levelWithProgress: 18 }
        },
        skillAverage: 28.8,
        sbLevel: 184.32,
        networth: 631000000,
        networthFormatted: "631M",
        cataLevel: 20,
        slayerTotal: 17,
        inactiveDays: 1
      }),
      username: "TomPso11",
      isSelf: false,
      rng: () => 0.9
    });

    expect(result.comboKey).toBe("stage_core_floor+stage_sa_floor");
    expect(result.message.toLowerCase()).not.toContain("stacked stage core floor with stage sa floor");
    expect(result.message.toLowerCase()).toContain("failed both core and sa stage checks");
  });

  test("inventory api off is roastable instead of no-issue", () => {
    const result = evaluateRoast({
      stats: makeStats({
        sbLevel: 260,
        skillAverage: 46,
        skills: {
          combat: { levelWithProgress: 50 },
          mining: { levelWithProgress: 50 },
          farming: { levelWithProgress: 50 },
          fishing: { levelWithProgress: 45 },
          foraging: { levelWithProgress: 45 },
          enchanting: { levelWithProgress: 45 },
          alchemy: { levelWithProgress: 42 },
          taming: { levelWithProgress: 45 },
          carpentry: { levelWithProgress: 42 }
        },
        cataLevel: 35,
        slayerTotal: 40,
        inactiveDays: 0,
        inventoryApiOff: true,
        networth: 0,
        networthFormatted: "0"
      }),
      username: "HiddenProfile",
      isSelf: false,
      rng: () => 0
    });

    expect(result.classification).toBe("SKILL_ISSUE");
    expect(result.findings.some((finding) => finding.id === "inventory_api_off")).toBe(true);
  });

  test("inventory api off bypasses new-player protection even with low stats", () => {
    const result = evaluateRoast({
      stats: makeStats({
        sbLevel: 12,
        skillAverage: 8,
        networth: 0,
        networthFormatted: "0",
        inventoryApiOff: true
      }),
      username: "ApiOffPlayer",
      isSelf: false,
      rng: () => 0.4
    });

    expect(result.classification).toBe("SKILL_ISSUE");
    expect(result.classification).not.toBe("NEW_PLAYER_PROTECTED");
  });

  test("nuke line can trigger with severe finding", () => {
    const result = evaluateRoast({
      stats: makeStats({
        sbLevel: 430,
        skillAverage: 36,
        networth: 12000000000,
        networthFormatted: "12B",
        skills: {
          combat: { levelWithProgress: 58 },
          mining: { levelWithProgress: 30 },
          farming: { levelWithProgress: 58 },
          fishing: { levelWithProgress: 47 },
          foraging: { levelWithProgress: 47 },
          enchanting: { levelWithProgress: 58 },
          alchemy: { levelWithProgress: 47 },
          taming: { levelWithProgress: 58 },
          carpentry: { levelWithProgress: 47 }
        }
      }),
      username: "EndgameGap",
      isSelf: false,
      rng: () => 0
    });

    expect(result.message.toLowerCase()).toContain("why");
  });

  test("stage floor is cap-aware for 50-cap skills at high sb level", () => {
    const result = evaluateRoast({
      stats: makeStats({
        sbLevel: 486.46,
        skillAverage: 54,
        networth: 15000000000,
        networthFormatted: "15B",
        cataLevel: 45,
        slayerTotal: 50,
        inactiveDays: 0,
        skills: {
          combat: { levelWithProgress: 60 },
          mining: { levelWithProgress: 60 },
          farming: { levelWithProgress: 60 },
          fishing: { levelWithProgress: 50 },
          foraging: { levelWithProgress: 50 },
          enchanting: { levelWithProgress: 60 },
          alchemy: { levelWithProgress: 50 },
          taming: { levelWithProgress: 60 },
          carpentry: { levelWithProgress: 50 }
        }
      }),
      username: "Jamesien",
      isSelf: false,
      rng: () => 0.7
    });

    expect(result.findings.some((finding) => finding.id === "stage_core_floor")).toBe(false);
  });

  test("escaped newline templates are unescaped before rendering", () => {
    const result = evaluateRoast({
      stats: makeStats({
        sbLevel: 430,
        skillAverage: 30,
        networth: 12000000000,
        networthFormatted: "12B",
        skills: {
          combat: { levelWithProgress: 58 },
          mining: { levelWithProgress: 30 },
          farming: { levelWithProgress: 58 },
          fishing: { levelWithProgress: 47 },
          foraging: { levelWithProgress: 47 },
          enchanting: { levelWithProgress: 58 },
          alchemy: { levelWithProgress: 47 },
          taming: { levelWithProgress: 58 },
          carpentry: { levelWithProgress: 47 }
        }
      }),
      username: "Escapes",
      isSelf: false,
      configRoast: {
        nukeChance: 1,
        nukeLines: ["{lineA}\\n{lineB}\\nexplain"]
      },
      rng: () => 0
    });

    expect(result.message.includes("\\n")).toBe(false);
  });
});
