const minecraftCommand = require("../../contracts/minecraftCommand.js");
const { getLatestProfile } = require("../../../API/functions/getLatestProfile.js");
const { getMuseum } = require("../../../API/functions/getMuseum.js");
const { ProfileNetworthCalculator } = require("skyhelper-networth");
const { getSkills } = require("../../../API/stats/skills.js");
const { getDungeons } = require("../../../API/stats/dungeons.js");
const { getSlayer } = require("../../../API/stats/slayer.js");
const { getSkillAverage } = require("../../../API/constants/skills.js");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const { formatNumber } = require("../../contracts/helperFunctions.js");
const hypixel = require("../../contracts/API/HypixelRebornAPI.js");
const { evaluateRoast, mergeRoastConfig } = require("../other/roastEngine.js");
const { readFileSync } = require("fs");

function loadRoastConfig() {
  try {
    const raw = readFileSync("roastConfig.json", "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // fallback to defaults inside mergeRoastConfig
  }

  return {};
}

class RoastCommand extends minecraftCommand {
  constructor(minecraft) {
    super(minecraft);

    this.name = "roast";
    this.aliases = ["skillissue"];
    this.description = "Roast a player based on progression gaps.";
    this.options = [
      {
        name: "username",
        description: "Minecraft username",
        required: false
      },
      {
        name: "profile",
        description: "Profile name, `latest`, or `highest`",
        required: false
      }
    ];

    this.cooldowns = new Map();
  }

  isOnCooldown(invoker, roastConfig) {
    const cooldownSeconds = Number(roastConfig.cooldownSeconds || 0);
    if (cooldownSeconds <= 0) {
      return false;
    }

    const key = String(invoker || "").toLowerCase();
    const now = Date.now();
    const expiresAt = this.cooldowns.get(key) || 0;
    if (now < expiresAt) {
      return true;
    }

    this.cooldowns.set(key, now + cooldownSeconds * 1000);
    return false;
  }

  async ensureGuildTarget(targetUsername, roastConfig) {
    if (!roastConfig.guildOnlyTargets) {
      return;
    }

    const uuid = await getUUID(targetUsername);
    const guild = await hypixel.getGuild("player", bot.username, { noCaching: true, noCacheCheck: true });
    const isGuildMember = guild?.members?.some((member) => member.uuid === uuid);
    if (!isGuildMember) {
      throw `${targetUsername} is not in the guild.`;
    }
  }

  async resolveTargetProfile({ targetUsername, requestedProfile }) {
    const latestData = await getLatestProfile(targetUsername);
    const { username, uuid } = latestData;
    const allProfiles = Array.isArray(latestData.profiles) ? latestData.profiles : [];
    if (!allProfiles.length) {
      throw `${username} has no SkyBlock profiles.`;
    }

    if (requestedProfile === "highest") {
      const ranked = [];
      const inventoryOffProfiles = [];

      for (const profileData of allProfiles) {
        const profileName = profileData?.cute_name || "Unknown";
        const profile = profileData?.members?.[uuid];
        if (!profile) {
          continue;
        }

        const museumResponse = await getMuseum(profileData.profile_id, uuid).catch(() => ({ museum: null }));
        const bankingBalance = profileData?.banking?.balance ?? 0;
        const networthManager = new ProfileNetworthCalculator(profile, museumResponse.museum, bankingBalance);
        const networthData = await networthManager.getNetworth({ onlyNetworth: true }).catch(() => null);
        if (!networthData || networthData.noInventory) {
          inventoryOffProfiles.push({
            profileData,
            profile,
            museum: museumResponse.museum,
            profileName,
            networth: 0,
            forceInventoryApiOff: true
          });
          continue;
        }

        ranked.push({
          profileData,
          profile,
          museum: museumResponse.museum,
          profileName,
          networth: Number(networthData?.networth || 0)
        });
      }

      if (!ranked.length) {
        const fallback = inventoryOffProfiles.find((entry) => entry.profileData?.selected) ||
          inventoryOffProfiles[0] || {
            profileData: allProfiles.find((entry) => entry.selected) || allProfiles[0],
            profile: (allProfiles.find((entry) => entry.selected) || allProfiles[0])?.members?.[uuid],
            museum: null,
            profileName: (allProfiles.find((entry) => entry.selected) || allProfiles[0])?.cute_name || "Unknown",
            networth: 0,
            forceInventoryApiOff: true
          };

        return {
          username,
          uuid,
          ...fallback
        };
      }

      return {
        username,
        uuid,
        ...ranked.sort((a, b) => b.networth - a.networth)[0]
      };
    }

    let profileData = null;
    if (requestedProfile === "latest") {
      profileData = allProfiles.find((entry) => entry.selected) || allProfiles[0];
    } else {
      profileData = allProfiles.find((entry) => String(entry?.cute_name || "").toLowerCase() === requestedProfile);
      if (!profileData) {
        const availableProfiles = allProfiles
          .map((entry) => entry?.cute_name)
          .filter(Boolean)
          .join(", ");
        throw `Profile \`${requestedProfile}\` not found. Available: ${availableProfiles || "none"}`;
      }
    }

    const profile = profileData?.members?.[uuid];
    if (!profile) {
      throw "Could not find player in selected profile.";
    }

    const museumResponse = await getMuseum(profileData.profile_id, uuid).catch(() => ({ museum: null }));
    return {
      username,
      uuid,
      profile,
      profileData,
      museum: museumResponse.museum,
      profileName: profileData?.cute_name || "Unknown",
      networth: null
    };
  }

  async buildRoastStats({ targetUsername, requestedProfile }) {
    const selected = await this.resolveTargetProfile({ targetUsername, requestedProfile });
    const { username, uuid, profile, profileData, museum, profileName, forceInventoryApiOff } = selected;

    const skills = getSkills(profile, profileData) || {};
    const skillAverage = Number(getSkillAverage(profile, null) || 0);
    const sbLevel = Number(profile?.leveling?.experience ? profile.leveling.experience / 100 : 0);

    const bankingBalance = profileData?.banking?.balance ?? 0;
    const networthManager = new ProfileNetworthCalculator(profile, museum, bankingBalance);
    const networthData = await networthManager.getNetworth({ onlyNetworth: true }).catch(() => ({ networth: 0, purse: 0, noInventory: true }));
    const inventoryApiOff = Boolean(forceInventoryApiOff || networthData.noInventory);

    const dungeons = getDungeons(profile);
    const cataLevel = Number(dungeons?.dungeons?.levelWithProgress ?? 0);
    const slayer = getSlayer(profile);
    const slayerTotal = slayer
      ? Number(["zombie", "spider", "wolf", "enderman", "blaze", "vampire"].map((key) => Number(slayer?.[key]?.level || 0)).reduce((acc, value) => acc + value, 0))
      : 0;

    const hypixelPlayer = await hypixel.getPlayer(uuid, { guild: false }).catch(() => null);
    const lastLogin = hypixelPlayer?.lastLogin ? new Date(hypixelPlayer.lastLogin).getTime() : null;
    const inactiveDays = Number.isFinite(lastLogin) ? Math.max(0, Math.floor((Date.now() - lastLogin) / (24 * 60 * 60 * 1000))) : 0;

    return {
      username,
      profileName,
      stats: {
        skills,
        skillAverage,
        sbLevel,
        networth: Number(networthData?.networth || 0),
        networthFormatted: formatNumber(networthData?.networth || 0),
        cataLevel,
        slayerTotal,
        inactiveDays,
        inventoryApiOff
      }
    };
  }

  /**
   * @param {string} player
   * @param {string} message
   */
  async onCommand(player, message) {
    try {
      const roastConfig = mergeRoastConfig(loadRoastConfig());
      if (!roastConfig.enabled) {
        return this.send("Roast command is disabled.");
      }

      if (this.isOnCooldown(player, roastConfig)) {
        return this.send(`${player} roast command is on cooldown.`);
      }

      const args = this.getArgs(message);
      const firstArg = args[0];
      const secondArg = args[1];
      const explicitTarget = firstArg && firstArg !== "-" ? firstArg : null;
      const isSelf = !explicitTarget;
      const targetUsername = explicitTarget || player;
      const requestedProfile = (secondArg || "latest").toLowerCase();

      if (explicitTarget) {
        await this.ensureGuildTarget(targetUsername, roastConfig);
      }

      const { username, stats, profileName } = await this.buildRoastStats({ targetUsername, requestedProfile });
      const result = evaluateRoast({
        stats,
        username,
        isSelf,
        configRoast: roastConfig,
        rng: Math.random
      });

      const compactMessage = String(result.message || "")
        .replace(/\s*\n+\s*/g, " | ")
        .replace(/\s{2,}/g, " ")
        .trim();

      await this.send(`${compactMessage} [${profileName}]`);
    } catch (error) {
      console.error(error);
      await this.send(`[ERROR] ${error}`);
    }
  }
}

module.exports = RoastCommand;
