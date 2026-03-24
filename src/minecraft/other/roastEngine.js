const { replaceVariables, titleCase } = require("../../contracts/helperFunctions.js");

const DEFAULT_ROAST_CONFIG = {
  enabled: true,
  guildOnlyTargets: true,
  profileMode: "latest",
  cooldownSeconds: 20,
  skillIssueScoreThreshold: 4,
  newPlayerGuard: {
    sbLevelBelow: 60,
    skillAverageBelow: 20,
    networthBelow: 100000000
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
    }
  }
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

  config.comboTemplates = {
    ...DEFAULT_ROAST_CONFIG.comboTemplates,
    ...(configRoast?.comboTemplates || {})
  };

  config.roastTemplatesByRule = {
    ...DEFAULT_ROAST_CONFIG.roastTemplatesByRule,
    ...(configRoast?.roastTemplatesByRule || {})
  };

  return config;
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

  return findings;
}

function getCombo(findings) {
  const ids = new Set(findings.map((finding) => finding.id));
  const combos = [
    ["rich_low_sa", "one_trick_profile"],
    ["combat_mining_gap", "dungeon_main_syndrome"],
    ["rich_low_sa", "combat_mining_gap"],
    ["fake_late_game", "activity_shame"],
    ["one_trick_profile", "combat_farming_gap"]
  ];

  for (const combo of combos) {
    if (combo.every((id) => ids.has(id))) {
      return combo.sort().join("+");
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
    const genericComboLine = `${username} stacked ${titleCase(firstRule)} + ${titleCase(secondRule)}. that combo is illegal.`;
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
    stats.sbLevel < config.newPlayerGuard.sbLevelBelow ||
    stats.skillAverage < config.newPlayerGuard.skillAverageBelow ||
    stats.networth < config.newPlayerGuard.networthBelow;

  if (isNewPlayer) {
    const setupLine = isSelf ? pickRandom(config.selfIntroLines, rng) : pickRandom(config.responseStructure.setup.default, rng);
    const mainHitLine = interpolate(pickRandom(config.newPlayerReplies, rng), { username });
    const closerLine = pickCloser(config, "NEW_PLAYER_PROTECTED", "mild", rng);

    return {
      classification: "NEW_PLAYER_PROTECTED",
      findings: [],
      severity: "mild",
      message: `${setupLine} ${mainHitLine} ${closerLine}`.trim()
    };
  }

  const rawFindings = evaluateRules(stats, config);
  if (rawFindings.length === 0) {
    const setupLine = isSelf ? pickRandom(config.selfIntroLines, rng) : pickRandom(config.responseStructure.setup.default, rng);
    const mainHitLine = interpolate(pickRandom(config.noIssueReplies, rng), { username });
    const closerLine = pickCloser(config, "NO_ISSUE", "mild", rng);

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
  const setupLine = isSelf ? pickRandom(config.selfIntroLines, rng) : pickRandom(setupPool, rng);
  const closerLine = pickCloser(config, "SKILL_ISSUE", strongestSeverity, rng);

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
    getCombo,
    prioritizeFindings,
    getSeverityFromValue,
    pickRandom
  }
};
