const { replaceVariables, titleCase } = require("../../contracts/helperFunctions.js");

const DEFAULT_ROAST_CONFIG = {
  enabled: true,
  guildOnlyTargets: true,
  profileMode: "latest",
  cooldownSeconds: 20,
  skillIssueScoreThreshold: 4,
  newPlayerGuard: {
    sbLevelBelow: 30,
    skillAverageBelow: 12,
    networthBelow: 25000000
  },
  qualityFilter: {
    minPriorityForSpecific: 4,
    mildSingleRuleFallback: true
  },
  minGaps: {
    combatMiningGap: 15,
    combatFarmingGap: 15,
    oneTrickGap: 20
  },
  nukeChance: 0.05,
  severityMultipliers: {
    mild: 1,
    high: 1.35,
    extreme: 1.75
  },
  priorityBoosts: {
    self: 2,
    extreme: 3,
    combo: 2
  },
  responseStructure: {
    setup: {
      default: [
        "alright {username}, let us check this crime scene.",
        "stat check time for {username}...",
        "pulling up {username}'s profile for scientific bullying."
      ],
      combo: [
        "this is a two-for-one special, {username}.",
        "okay {username}, this combo is genuinely nasty.",
        "bro stacked issues like enchantments, {username}."
      ]
    },
    closer: {
      mild: [
        "skill issue aint fixing itself, start grinding.",
        "small fix, big improvement. get to work.",
        "you are one detour away from being decent."
      ],
      high: [
        "stop dodging progression and fix it.",
        "this build is held together by cope.",
        "respectfully, go grind the basics."
      ],
      extreme: [
        "drop everything and repair your profile.",
        "this is not a build, it is a warning sign.",
        "full rebuild angle. now."
      ],
      noIssue: [
        "annoyingly balanced. go outside.",
        "no easy angle today. touch grass.",
        "you win this round. unfortunately."
      ],
      newPlayer: [
        "enjoy immunity while it lasts.",
        "you are protected... for now.",
        "rookie shield active. temporary." 
      ]
    }
  },
  selfIntroLines: ["you asked for this ??", "bro snitched on himself", "self report detected"],
  noIssueReplies: [
    "i tried finding a skill issue but this is annoyingly balanced.",
    "no roast today... and i hate that for me.",
    "this profile is suspiciously normal."
  ],
  newPlayerReplies: [
    "you are still early game, i will allow it... for now ??",
    "new player immunity activated. come back after some grind.",
    "too fresh to roast properly. enjoy your grace period."
  ],
  genericRoastReplies: [
    "there is definitely a skill issue in here somewhere, go grind fundamentals.",
    "progression looking shaky, fix the basics first.",
    "this profile needs less ego and more consistency."
  ],
  nukeLines: [
    "{lineA}\n{lineB}\nwhy",
    "{lineA}\n{lineB}\nexplain",
    "{lineA}\n{lineB}\nthis cannot be real"
  ],
  comboTemplates: {
    "rich_low_sa+one_trick_profile": {
      mild: ["{username} has money and one skill. progression forgot to load."],
      high: ["{username} is rich, one-trick, and somehow still undercooked."],
      extreme: ["{username} got rich without building a profile. this is fraud."]
    },
    "combat_mining_gap+dungeon_main_syndrome": {
      mild: ["{username} min-maxed combat and forgot everything else exists."],
      high: ["{username} lives in dungeons and still refuses to mine. wild."],
      extreme: ["{username} is dungeon-locked with a mining allergy. emergency."]
    },
    "midgame_low_sa+core_skills_behind": {
      mild: ["{username} has midgame level but earlygame fundamentals. core skills are lagging hard."],
      high: ["SB {sbLevel} with SA {skillAverage} and weak core skills. progression got skipped."],
      extreme: ["{username} speedran levels and forgot to build fundamentals."]
    },
    "stage_core_floor+stage_sa_floor": {
      mild: ["{username} is behind both core skill floor and SA floor for this bracket."],
      high: ["SB {sbLevel} and both core + SA floors are missed. this stage is underbuilt."],
      extreme: ["{username} failed both core and SA stage checks. hard rebuild angle."]
    }
  },
  roastTemplatesByRule: {
    combat_mining_gap: {
      mild: ["{username} combat {combat} vs mining {mining}... maybe buy a pickaxe."],
      high: ["combat {combat} and mining {mining}? bro discovered half the game."],
      extreme: ["{lineA}\n{lineB}\nthis gap is a lifestyle choice."]
    },
    combat_farming_gap: {
      mild: ["{username} fights everything but farms nothing."],
      high: ["combat {combat}, farming {farming}. potatoes are scared of you too?"],
      extreme: ["{lineA}\n{lineB}\nfarming got abandoned."]
    },
    one_trick_profile: {
      mild: ["{username} built a profile around one skill and vibes."],
      high: ["{username} did not build a profile, just a one-skill personality."],
      extreme: ["{username} is a one-trick documentary."]
    },
    rich_low_sa: {
      mild: ["{username} has coins but forgot to buy progression."],
      high: ["{username} has {networth} networth and SA {skillAverage}. wealth fraud."],
      extreme: ["{username} got rich and skipped the game."]
    },
    fake_late_game: {
      mild: ["{username} has late-game vibes with early-game utility skills."],
      high: ["{username} is high level but still ducking alchemy/enchanting."],
      extreme: ["late-game title, tutorial utility skills."]
    },
    dungeon_main_syndrome: {
      mild: ["{username} is a little too comfy in dungeons."],
      high: ["cata {cata} and SA {skillAverage} is not the flex you think."],
      extreme: ["{username} lives in dungeons because outside is scary."]
    },
    activity_shame: {
      mild: ["{username} has not logged in for {inactiveDays}d. skill issue became login issue."],
      high: ["{inactiveDays}d offline... progression is in a coma."],
      extreme: ["{inactiveDays}d offline. account fossilized."]
    },
    midgame_low_sa: {
      mild: ["{username} is level {sbLevel} with SA {skillAverage}. fundamentals got skipped."],
      high: ["sb {sbLevel} and SA {skillAverage} is criminally undercooked."],
      extreme: ["{username} has a midgame badge with earlygame fundamentals."]
    },
    core_skills_behind: {
      mild: ["{username}'s {lowestSkillName} is only {lowestSkillValue}. that is holding the whole profile back."],
      high: ["core skill check failed: {lowestSkillName} {lowestSkillValue}. fix the basics."],
      extreme: ["{lineA}\n{lineB}\nthis is why progression feels cursed."]
    },
    stage_core_floor: {
      mild: ["{username} is SB {sbLevel} but {lowestCoreName} is only {lowestCoreValue}."],
      high: ["{lowestCoreName} {lowestCoreValue} at SB {sbLevel}? that is behind for this stage."],
      extreme: ["{lineA}\n{lineB}\ncore progression failed the stage check."]
    },
    stage_utility_floor: {
      mild: ["utility check says {lowestUtilityName} {lowestUtilityValue}. that is behind for this stage."],
      high: ["{username} skipped utility skill leveling: {lowestUtilityName} {lowestUtilityValue}."],
      extreme: ["{lineA}\n{lineB}\nthis utility gap is griefing your progression."]
    },
    stage_sa_floor: {
      mild: ["SB {sbLevel} with SA {skillAverage}. that average is behind for this stage."],
      high: ["SA {skillAverage} is under where this bracket should be."],
      extreme: ["{lineA}\n{lineB}\nstage average is nowhere near ready."]
    },
    stage_networth_floor: {
      mild: ["{username} is SB {sbLevel} with only {networth}. economy is behind for this stage."],
      high: ["{networth} networth at this stage is undercooked."],
      extreme: ["{lineA}\n{lineB}\nthis economy is still tutorial mode."]
    },
    stage_cata_floor: {
      mild: ["cata {cata} is behind for this stage."],
      high: ["SB {sbLevel} with cata {cata} is behind the bracket curve."],
      extreme: ["{lineA}\n{lineB}\ndungeon progression is missing."]
    },
    stage_slayer_floor: {
      mild: ["slayer total {slayerTotal} is low for this stage."],
      high: ["{username} skipped slayers: total {slayerTotal} is behind."],
      extreme: ["{lineA}\n{lineB}\nslayer progression is absent."]
    },
    endgame_nonmax: {
      mild: ["endgame check: {worstSkillName} {worstSkillValue} is still not near max."],
      high: ["SB {sbLevel} endgame with {worstSkillName} {worstSkillValue} is not near max."],
      extreme: ["{lineA}\n{lineB}\nendgame badge without endgame skills."]
    },
    endgame_rich_not_maxed: {
      mild: ["{username} has {networth} but still not near-maxed."],
      high: ["{networth} networth and {worstSkillName} {worstSkillValue}. rich but unfinished."],
      extreme: ["{lineA}\n{lineB}\nwealth cannot hide this gap."]
    },
    inventory_api_off: {
      mild: ["inventory api is off, so progression is hiding behind privacy settings."],
      high: ["{username} turned inventory api off. suspicious behavior detected."],
      extreme: ["inventory api off\nprofile hidden\nthat says enough."]
    },
    ceiling_pressure: {
      mild: ["no catastrophic issue, but this profile is still leaving free progress on the table."],
      high: ["{username} is stable, not sharp. optimization debt is massive."],
      extreme: ["{lineA}\n{lineB}\nprofile is coasting too hard."]
    }
  }
};

const STAGE_PACKS = [
  {
    key: "lt100",
    min: 0,
    max: 99.999,
    floors: { core: 15, utility: 10, sa: 18, networth: 50000000, cata: 8, slayerTotal: 8 }
  },
  {
    key: "100_199",
    min: 100,
    max: 199.999,
    floors: { core: 28, utility: 16, sa: 30, networth: 500000000, cata: 18, slayerTotal: 18 }
  },
  {
    key: "200_299",
    min: 200,
    max: 299.999,
    floors: { core: 38, utility: 26, sa: 38, networth: 2000000000, cata: 28, slayerTotal: 28 }
  },
  {
    key: "300_399",
    min: 300,
    max: 399.999,
    floors: { core: 46, utility: 34, sa: 46, networth: 5000000000, cata: 36, slayerTotal: 38 }
  },
  {
    key: "400_500",
    min: 400,
    max: Number.POSITIVE_INFINITY,
    floors: { core: 54, utility: 42, sa: 52, networth: 10000000000, cata: 42, slayerTotal: 45 }
  }
];

const SKILL_CAPS = {
  combat: 60,
  mining: 60,
  farming: 60,
  enchanting: 60,
  taming: 60,
  foraging: 50,
  fishing: 50,
  alchemy: 50,
  carpentry: 50,
  runecrafting: 25,
  social: 25
};

function pickRandom(list, rng = Math.random) {
  if (!Array.isArray(list) || list.length === 0) {
    return "";
  }

  const index = Math.floor(rng() * list.length);
  return list[index] || list[0];
}

function getSkill(skills, key) {
  const value = skills?.[key];
  if (!value) {
    return 0;
  }

  return Number(value.levelWithProgress ?? value.level ?? 0) || 0;
}

function getSeverityFromValue(value, thresholds) {
  if (value >= thresholds.extreme) return "extreme";
  if (value >= thresholds.high) return "high";
  return "mild";
}

function normalizeComboKey(key) {
  return String(key || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join("+");
}

function formatRuleIdForText(id) {
  return String(id || "")
    .split("_")
    .join(" ")
    .toLowerCase();
}

function mergeRoastConfig(configRoast) {
  const config = {
    ...DEFAULT_ROAST_CONFIG,
    ...(configRoast && typeof configRoast === "object" ? configRoast : {})
  };

  config.newPlayerGuard = {
    ...DEFAULT_ROAST_CONFIG.newPlayerGuard,
    ...(configRoast?.newPlayerGuard || {})
  };

  config.qualityFilter = {
    ...DEFAULT_ROAST_CONFIG.qualityFilter,
    ...(configRoast?.qualityFilter || {})
  };

  config.minGaps = {
    ...DEFAULT_ROAST_CONFIG.minGaps,
    ...(configRoast?.minGaps || {})
  };

  config.severityMultipliers = {
    ...DEFAULT_ROAST_CONFIG.severityMultipliers,
    ...(configRoast?.severityMultipliers || {})
  };

  config.priorityBoosts = {
    ...DEFAULT_ROAST_CONFIG.priorityBoosts,
    ...(configRoast?.priorityBoosts || {})
  };

  config.responseStructure = {
    setup: {
      ...DEFAULT_ROAST_CONFIG.responseStructure.setup,
      ...(configRoast?.responseStructure?.setup || {})
    },
    closer: {
      ...DEFAULT_ROAST_CONFIG.responseStructure.closer,
      ...(configRoast?.responseStructure?.closer || {})
    }
  };

  const mergedComboTemplates = {
    ...DEFAULT_ROAST_CONFIG.comboTemplates,
    ...(configRoast?.comboTemplates || {})
  };
  config.comboTemplates = Object.entries(mergedComboTemplates).reduce((acc, [key, value]) => {
    acc[normalizeComboKey(key)] = value;
    return acc;
  }, {});

  config.roastTemplatesByRule = {
    ...DEFAULT_ROAST_CONFIG.roastTemplatesByRule,
    ...(configRoast?.roastTemplatesByRule || {})
  };

  return config;
}

function resolveStagePack(sbLevel) {
  return STAGE_PACKS.find((stage) => sbLevel >= stage.min && sbLevel <= stage.max) || STAGE_PACKS[0];
}

function evaluateStageRules({ stats, skills, avgSkill, stagePack }) {
  const findings = [];
  const sbLevelRounded = Number((stats.sbLevel || 0).toFixed(2));
  const coreSkills = ["combat", "mining", "farming", "fishing", "foraging"];
  const utilitySkills = ["enchanting", "alchemy", "taming", "carpentry"];

  const coreEntries = coreSkills.map((key) => {
    const value = getSkill(skills, key);
    const target = Math.min(stagePack.floors.core, SKILL_CAPS[key] || stagePack.floors.core);
    return { key, value, target, deficit: Math.max(0, target - value) };
  });
  const utilityEntries = utilitySkills.map((key) => {
    const value = getSkill(skills, key);
    const target = Math.min(stagePack.floors.utility, SKILL_CAPS[key] || stagePack.floors.utility);
    return { key, value, target, deficit: Math.max(0, target - value) };
  });

  const worstCore = coreEntries.reduce((acc, entry) => (entry.deficit > acc.deficit ? entry : acc), coreEntries[0]);
  const worstUtility = utilityEntries.reduce((acc, entry) => (entry.deficit > acc.deficit ? entry : acc), utilityEntries[0]);

  if (worstCore.deficit > 0) {
    const deficit = worstCore.deficit;
    findings.push({
      id: "stage_core_floor",
      weight: 4,
      severity: getSeverityFromValue(deficit, { high: 8, extreme: 14 }),
      data: {
        sbLevel: sbLevelRounded,
        lowestCoreName: titleCase(worstCore.key),
        lowestCoreValue: Math.floor(worstCore.value),
        target: worstCore.target,
        lineA: `${titleCase(worstCore.key)} ${Math.floor(worstCore.value)}`,
        lineB: `target ${worstCore.target}`
      }
    });
  }

  if (worstUtility.deficit > 0) {
    const deficit = worstUtility.deficit;
    findings.push({
      id: "stage_utility_floor",
      weight: 3,
      severity: getSeverityFromValue(deficit, { high: 8, extreme: 14 }),
      data: {
        sbLevel: sbLevelRounded,
        lowestUtilityName: titleCase(worstUtility.key),
        lowestUtilityValue: Math.floor(worstUtility.value),
        target: worstUtility.target,
        lineA: `${titleCase(worstUtility.key)} ${Math.floor(worstUtility.value)}`,
        lineB: `target ${worstUtility.target}`
      }
    });
  }

  if (avgSkill < stagePack.floors.sa) {
    const deficit = stagePack.floors.sa - avgSkill;
    findings.push({
      id: "stage_sa_floor",
      weight: 4,
      severity: getSeverityFromValue(deficit, { high: 4, extreme: 8 }),
      data: {
        sbLevel: sbLevelRounded,
        skillAverage: Number(avgSkill.toFixed(2)),
        target: stagePack.floors.sa,
        lineA: `SA ${Number(avgSkill.toFixed(2))}`,
        lineB: `target ${stagePack.floors.sa}`
      }
    });
  }

  if (!stats.inventoryApiOff && Number(stats.networth || 0) < stagePack.floors.networth) {
    const ratio = stagePack.floors.networth <= 0 ? 0 : Number(stats.networth || 0) / stagePack.floors.networth;
    findings.push({
      id: "stage_networth_floor",
      weight: 2,
      severity: ratio < 0.35 ? "extreme" : ratio < 0.65 ? "high" : "mild",
      data: {
        sbLevel: sbLevelRounded,
        networth: stats.networthFormatted || "0",
        targetNetworth: `${Math.round(stagePack.floors.networth / 100000000) / 10}B`,
        lineA: `networth ${stats.networthFormatted || "0"}`,
        lineB: `target ${Math.round(stagePack.floors.networth / 100000000) / 10}B`
      }
    });
  }

  if (Number(stats.cataLevel || 0) < stagePack.floors.cata) {
    const deficit = stagePack.floors.cata - Number(stats.cataLevel || 0);
    findings.push({
      id: "stage_cata_floor",
      weight: 2,
      severity: getSeverityFromValue(deficit, { high: 8, extreme: 14 }),
      data: {
        sbLevel: sbLevelRounded,
        cata: Number((stats.cataLevel || 0).toFixed(2)),
        target: stagePack.floors.cata,
        lineA: `cata ${Number((stats.cataLevel || 0).toFixed(2))}`,
        lineB: `target ${stagePack.floors.cata}`
      }
    });
  }

  if (Number(stats.slayerTotal || 0) < stagePack.floors.slayerTotal) {
    const deficit = stagePack.floors.slayerTotal - Number(stats.slayerTotal || 0);
    findings.push({
      id: "stage_slayer_floor",
      weight: 2,
      severity: getSeverityFromValue(deficit, { high: 8, extreme: 16 }),
      data: {
        sbLevel: sbLevelRounded,
        slayerTotal: Math.floor(Number(stats.slayerTotal || 0)),
        target: stagePack.floors.slayerTotal,
        lineA: `slayer ${Math.floor(Number(stats.slayerTotal || 0))}`,
        lineB: `target ${stagePack.floors.slayerTotal}`
      }
    });
  }

  if (stagePack.key === "400_500") {
    const nearMaxTargets = {
      combat: SKILL_CAPS.combat - 2,
      mining: SKILL_CAPS.mining - 2,
      farming: SKILL_CAPS.farming - 2,
      enchanting: SKILL_CAPS.enchanting - 2,
      taming: SKILL_CAPS.taming - 2,
      foraging: SKILL_CAPS.foraging - 3,
      fishing: SKILL_CAPS.fishing - 3,
      alchemy: SKILL_CAPS.alchemy - 3,
      carpentry: SKILL_CAPS.carpentry - 3
    };

    let worst = { key: "combat", value: Number.POSITIVE_INFINITY, target: 0, deficit: 0 };
    for (const [skill, target] of Object.entries(nearMaxTargets)) {
      const value = getSkill(skills, skill);
      const deficit = target - value;
      if (deficit > worst.deficit) {
        worst = { key: skill, value, target, deficit };
      }
    }

    if (worst.deficit > 0) {
      findings.push({
        id: "endgame_nonmax",
        weight: 5,
        severity: getSeverityFromValue(worst.deficit, { high: 6, extreme: 11 }),
        data: {
          sbLevel: sbLevelRounded,
          worstSkillName: titleCase(worst.key),
          worstSkillValue: Math.floor(worst.value),
          target: worst.target,
          lineA: `${titleCase(worst.key)} ${Math.floor(worst.value)}`,
          lineB: `target ${worst.target}`
        }
      });

      if (!stats.inventoryApiOff && Number(stats.networth || 0) >= 8000000000) {
        findings.push({
          id: "endgame_rich_not_maxed",
          weight: 5,
          severity: worst.deficit >= 10 ? "extreme" : "high",
          data: {
            sbLevel: sbLevelRounded,
            networth: stats.networthFormatted || "0",
            worstSkillName: titleCase(worst.key),
            worstSkillValue: Math.floor(worst.value),
            target: worst.target,
            lineA: `${titleCase(worst.key)} ${Math.floor(worst.value)}`,
            lineB: `${stats.networthFormatted || "0"} networth`
          }
        });
      }
    }
  }

  return findings;
}

function evaluateRules(stats, config) {
  const skills = stats.skills || {};
  const combat = getSkill(skills, "combat");
  const mining = getSkill(skills, "mining");
  const farming = getSkill(skills, "farming");
  const alchemy = getSkill(skills, "alchemy");
  const enchanting = getSkill(skills, "enchanting");

  const skillValues = Object.values(skills).map((entry) => Number(entry.levelWithProgress ?? entry.level ?? 0) || 0);
  const maxSkill = skillValues.length > 0 ? Math.max(...skillValues) : 0;
  const avgSkill = Number(stats.skillAverage || 0);
  const oneTrickGap = Math.max(0, maxSkill - avgSkill);

  const findings = [];
  const minGaps = config?.minGaps || DEFAULT_ROAST_CONFIG.minGaps;
  const stagePack = resolveStagePack(Number(stats.sbLevel || 0));

  findings.push(...evaluateStageRules({ stats, skills, avgSkill, stagePack }));

  if (stats.inventoryApiOff) {
    findings.push({
      id: "inventory_api_off",
      weight: 4,
      severity: "high",
      data: {
        sbLevel: Number((stats.sbLevel || 0).toFixed(2))
      }
    });
  }

  const combatMiningGap = combat - mining;
  if (combat >= 50 && combatMiningGap >= minGaps.combatMiningGap) {
    findings.push({
      id: "combat_mining_gap",
      weight: 3,
      severity: getSeverityFromValue(combatMiningGap, { high: 25, extreme: 35 }),
      data: {
        combat: Math.floor(combat),
        mining: Math.floor(mining),
        gap: Math.floor(combatMiningGap),
        lineA: `combat ${Math.floor(combat)}`,
        lineB: `mining ${Math.floor(mining)}`
      }
    });
  }

  const combatFarmingGap = combat - farming;
  if (combat >= 50 && combatFarmingGap >= minGaps.combatFarmingGap) {
    findings.push({
      id: "combat_farming_gap",
      weight: 2,
      severity: getSeverityFromValue(combatFarmingGap, { high: 22, extreme: 32 }),
      data: {
        combat: Math.floor(combat),
        farming: Math.floor(farming),
        gap: Math.floor(combatFarmingGap),
        lineA: `combat ${Math.floor(combat)}`,
        lineB: `farming ${Math.floor(farming)}`
      }
    });
  }

  if (oneTrickGap >= minGaps.oneTrickGap) {
    findings.push({
      id: "one_trick_profile",
      weight: 2,
      severity: getSeverityFromValue(oneTrickGap, { high: 28, extreme: 36 }),
      data: {
        maxSkill: Number(maxSkill.toFixed(1)),
        avgSkill: Number(avgSkill.toFixed(1)),
        gap: Number(oneTrickGap.toFixed(1))
      }
    });
  }

  if (stats.sbLevel >= 120 && avgSkill < 32) {
    const deficit = Math.max(0, 32 - avgSkill);
    findings.push({
      id: "midgame_low_sa",
      weight: 2,
      severity: getSeverityFromValue(deficit, { high: 3, extreme: 6 }),
      data: {
        sbLevel: Number(stats.sbLevel.toFixed(2)),
        skillAverage: Number(avgSkill.toFixed(2))
      }
    });
  }

  const coreSkills = [
    { key: "combat", value: combat },
    { key: "mining", value: mining },
    { key: "farming", value: farming }
  ];
  const lowestCore = coreSkills.reduce((min, entry) => (entry.value < min.value ? entry : min), coreSkills[0]);

  if (stats.sbLevel >= 140 && lowestCore.value < 30) {
    const deficit = Math.max(0, 30 - lowestCore.value);
    findings.push({
      id: "core_skills_behind",
      weight: 3,
      severity: getSeverityFromValue(deficit, { high: 4, extreme: 8 }),
      data: {
        sbLevel: Number(stats.sbLevel.toFixed(2)),
        lowestSkillName: titleCase(lowestCore.key),
        lowestSkillValue: Math.floor(lowestCore.value),
        lineA: `${titleCase(lowestCore.key)} ${Math.floor(lowestCore.value)}`,
        lineB: "minimum core target 30"
      }
    });
  }

  if (stats.networth >= 5000000000 && avgSkill < 32) {
    const score = (stats.networth >= 10000000000 ? 2 : 1) + (avgSkill < 30 ? 2 : 1);
    const severity = score >= 4 ? "extreme" : score >= 3 ? "high" : "mild";
    findings.push({
      id: "rich_low_sa",
      weight: 2,
      severity,
      data: {
        networth: stats.networthFormatted,
        skillAverage: Number(avgSkill.toFixed(2))
      }
    });
  }

  if (stats.sbLevel >= 200 && (alchemy < 20 || enchanting < 25)) {
    const missing = [
      { skill: "alchemy", value: alchemy, target: 20 },
      { skill: "enchanting", value: enchanting, target: 25 }
    ].filter((entry) => entry.value < entry.target);

    const severity = missing.length === 2 ? "high" : "mild";
    findings.push({
      id: "fake_late_game",
      weight: 2,
      severity: missing.length === 2 && Math.min(alchemy, enchanting) < 15 ? "extreme" : severity,
      data: {
        sbLevel: Math.floor(stats.sbLevel),
        alchemy: Math.floor(alchemy),
        enchanting: Math.floor(enchanting)
      }
    });
  }

  if (stats.cataLevel >= 35 && avgSkill < 32) {
    const cataGap = stats.cataLevel - avgSkill;
    findings.push({
      id: "dungeon_main_syndrome",
      weight: 2,
      severity: getSeverityFromValue(cataGap, { high: 8, extreme: 16 }),
      data: {
        cata: Number(stats.cataLevel.toFixed(2)),
        skillAverage: Number(avgSkill.toFixed(2))
      }
    });
  }

  if (stats.inactiveDays >= 7) {
    findings.push({
      id: "activity_shame",
      weight: 1,
      severity: getSeverityFromValue(stats.inactiveDays, { high: 14, extreme: 30 }),
      data: {
        inactiveDays: Math.floor(stats.inactiveDays)
      }
    });
  }

  if (findings.length === 0 && Number(stats.sbLevel || 0) >= 100) {
    const severity = stats.sbLevel >= 400 ? "high" : "mild";
    findings.push({
      id: "ceiling_pressure",
      weight: 2,
      severity,
      data: {
        sbLevel: Number((stats.sbLevel || 0).toFixed(2)),
        lineA: `SB ${Number((stats.sbLevel || 0).toFixed(2))}`,
        lineB: "plateau detected"
      }
    });
  }

  return findings;
}

function getCombo(findings) {
  const ids = new Set(findings.map((finding) => finding.id));
  const combos = [
    ["stage_core_floor", "stage_sa_floor"],
    ["stage_utility_floor", "stage_sa_floor"],
    ["endgame_nonmax", "endgame_rich_not_maxed"],
    ["inventory_api_off", "stage_sa_floor"],
    ["rich_low_sa", "one_trick_profile"],
    ["combat_mining_gap", "dungeon_main_syndrome"],
    ["rich_low_sa", "combat_mining_gap"],
    ["fake_late_game", "activity_shame"],
    ["one_trick_profile", "combat_farming_gap"],
    ["midgame_low_sa", "core_skills_behind"]
  ];

  for (const combo of combos) {
    if (combo.every((id) => ids.has(id))) {
      return normalizeComboKey(combo.join("+"));
    }
  }

  return null;
}

function severityScore(severity) {
  switch (severity) {
    case "extreme":
      return 3;
    case "high":
      return 2;
    default:
      return 1;
  }
}

function prioritizeFindings(findings, { isSelf, comboKey, config }) {
  const comboIds = comboKey ? new Set(comboKey.split("+")) : new Set();

  return findings
    .map((finding) => {
      const severityMultiplier = Number(config.severityMultipliers?.[finding.severity] || 1);
      const priority =
        finding.weight * severityMultiplier +
        (finding.severity === "extreme" ? config.priorityBoosts.extreme : 0) +
        (comboIds.has(finding.id) ? config.priorityBoosts.combo : 0) +
        (isSelf ? config.priorityBoosts.self : 0);

      return {
        ...finding,
        priorityScore: priority
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || severityScore(b.severity) - severityScore(a.severity) || b.weight - a.weight)
    .slice(0, 2);
}

function interpolate(template, context) {
  return replaceVariables(template, context);
}

function buildSpecificMainHit({ username, findings, comboKey, config, rng }) {
  const top = findings[0];
  const strongestSeverity = findings.reduce((acc, finding) => (severityScore(finding.severity) > severityScore(acc) ? finding.severity : acc), top.severity);

  if (comboKey && config.comboTemplates?.[comboKey]) {
    const template = pickRandom(config.comboTemplates[comboKey][strongestSeverity] || config.comboTemplates[comboKey].high || [], rng);
    if (template) {
      return interpolate(template, { username, ...top.data, ...(findings[1]?.data || {}) });
    }
  }

  if (comboKey) {
    const [firstRule, secondRule] = comboKey.split("+");
    const genericComboLine = `${username} stacked ${formatRuleIdForText(firstRule)} with ${formatRuleIdForText(secondRule)}. that combo is cursed.`;
    return genericComboLine;
  }

  const ruleTemplates = config.roastTemplatesByRule?.[top.id] || {};
  const template = pickRandom(ruleTemplates[top.severity] || ruleTemplates.high || ruleTemplates.mild || [], rng);
  if (template) {
    return interpolate(template, { username, ...top.data });
  }

  return interpolate(pickRandom(config.genericRoastReplies, rng), { username, ...top.data });
}

function maybeBuildNuke({ findings, config, rng, username }) {
  const hasSevere = findings.some((finding) => finding.severity === "extreme" || finding.severity === "high");
  if (!hasSevere || rng() >= Number(config.nukeChance || 0)) {
    return null;
  }

  const first = findings[0];
  const lineA = first?.data?.lineA || `${titleCase(first.id.replaceAll("_", " "))}`;
  const lineB = first?.data?.lineB || `severity ${first.severity}`;
  const template = pickRandom(config.nukeLines, rng);
  return interpolate(template, { username, lineA, lineB, ...first.data });
}

function pickCloser(config, classification, severity, rng) {
  if (classification === "NEW_PLAYER_PROTECTED") {
    return pickRandom(config.responseStructure.closer.newPlayer, rng);
  }

  if (classification === "NO_ISSUE") {
    return pickRandom(config.responseStructure.closer.noIssue, rng);
  }

  return pickRandom(config.responseStructure.closer[severity] || config.responseStructure.closer.high, rng);
}

function evaluateRoast({ stats, username, isSelf, configRoast, rng = Math.random }) {
  const config = mergeRoastConfig(configRoast);

  const isNewPlayer =
    !stats.inventoryApiOff &&
    (stats.sbLevel < config.newPlayerGuard.sbLevelBelow ||
      stats.skillAverage < config.newPlayerGuard.skillAverageBelow ||
      stats.networth < config.newPlayerGuard.networthBelow);

  if (isNewPlayer) {
    const setupLineRaw = isSelf ? pickRandom(config.selfIntroLines, rng) : pickRandom(config.responseStructure.setup.default, rng);
    const setupLine = interpolate(setupLineRaw, { username });
    const mainHitLine = interpolate(pickRandom(config.newPlayerReplies, rng), { username });
    const closerLine = interpolate(pickCloser(config, "NEW_PLAYER_PROTECTED", "mild", rng), { username });

    return {
      classification: "NEW_PLAYER_PROTECTED",
      findings: [],
      severity: "mild",
      message: `${setupLine} ${mainHitLine} ${closerLine}`.trim()
    };
  }

  const rawFindings = evaluateRules(stats, config);
  if (rawFindings.length === 0) {
    const setupLineRaw = isSelf ? pickRandom(config.selfIntroLines, rng) : pickRandom(config.responseStructure.setup.default, rng);
    const setupLine = interpolate(setupLineRaw, { username });
    const mainHitLine = interpolate(pickRandom(config.noIssueReplies, rng), { username });
    const closerLine = interpolate(pickCloser(config, "NO_ISSUE", "mild", rng), { username });

    return {
      classification: "NO_ISSUE",
      findings: [],
      severity: "mild",
      message: `${setupLine} ${mainHitLine} ${closerLine}`.trim()
    };
  }

  const comboKey = getCombo(rawFindings);
  const findings = prioritizeFindings(rawFindings, { isSelf, comboKey, config });

  const totalScore = findings.reduce((acc, finding) => acc + finding.weight, 0);
  const strongestSeverity = findings.reduce((acc, finding) => (severityScore(finding.severity) > severityScore(acc) ? finding.severity : acc), findings[0].severity);

  const useGenericFallback =
    config.qualityFilter.mildSingleRuleFallback === true &&
    findings.length === 1 &&
    findings[0].severity === "mild" &&
    findings[0].priorityScore < config.qualityFilter.minPriorityForSpecific;

  let mainHitLine = "";
  if (useGenericFallback) {
    mainHitLine = interpolate(pickRandom(config.genericRoastReplies, rng), { username });
  } else {
    mainHitLine = buildSpecificMainHit({ username, findings, comboKey, config, rng });
  }

  const nukeLine = maybeBuildNuke({ findings, config, rng, username });
  if (nukeLine) {
    mainHitLine = nukeLine;
  }

  const setupPool = comboKey ? config.responseStructure.setup.combo : config.responseStructure.setup.default;
  const setupLineRaw = isSelf ? pickRandom(config.selfIntroLines, rng) : pickRandom(setupPool, rng);
  const setupLine = interpolate(setupLineRaw, { username });
  const closerLine = interpolate(pickCloser(config, "SKILL_ISSUE", strongestSeverity, rng), { username });

  return {
    classification: totalScore >= config.skillIssueScoreThreshold ? "SKILL_ISSUE" : "SKILL_ISSUE",
    findings,
    severity: strongestSeverity,
    comboKey,
    message: `${setupLine} ${mainHitLine} ${closerLine}`.trim()
  };
}

module.exports = {
  evaluateRoast,
  mergeRoastConfig,
  _private: {
    evaluateRules,
    resolveStagePack,
    getCombo,
    prioritizeFindings,
    getSeverityFromValue,
    pickRandom
  }
};
