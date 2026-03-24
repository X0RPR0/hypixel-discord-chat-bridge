const minecraftCommand = require("../../contracts/minecraftCommand.js");
const { getLatestProfile } = require("../../../API/functions/getLatestProfile.js");
const { ProfileNetworthCalculator } = require("skyhelper-networth");
const { getSkills } = require("../../../API/stats/skills.js");
const { getDungeons } = require("../../../API/stats/dungeons.js");
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

  async buildRoastStats(targetUsername) {
    const latest = await getLatestProfile(targetUsername, { museum: true });
    const { username, uuid, profile, profileData, museum } = latest;

    const skills = getSkills(profile, profileData) || {};
    const skillAverage = Number(getSkillAverage(profile, null) || 0);
    const sbLevel = Number(profile?.leveling?.experience ? profile.leveling.experience / 100 : 0);

    const bankingBalance = profileData?.banking?.balance ?? 0;
    const networthManager = new ProfileNetworthCalculator(profile, museum, bankingBalance);
    const networthData = await networthManager.getNetworth({ onlyNetworth: true }).catch(() => ({ networth: 0, purse: 0, noInventory: true }));

    if (networthData.noInventory) {
      throw `${username} has Inventory API disabled.`;
    }

    const dungeons = getDungeons(profile);
    const cataLevel = Number(dungeons?.dungeons?.levelWithProgress ?? 0);

    const hypixelPlayer = await hypixel.getPlayer(uuid, { guild: false }).catch(() => null);
    const lastLogin = hypixelPlayer?.lastLogin ? new Date(hypixelPlayer.lastLogin).getTime() : null;
    const inactiveDays = Number.isFinite(lastLogin) ? Math.max(0, Math.floor((Date.now() - lastLogin) / (24 * 60 * 60 * 1000))) : 0;

    return {
      username,
      stats: {
        skills,
        skillAverage,
        sbLevel,
        networth: Number(networthData?.networth || 0),
        networthFormatted: formatNumber(networthData?.networth || 0),
        cataLevel,
        inactiveDays
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
      const explicitTarget = args[0] || null;
      const isSelf = !explicitTarget;
      const targetUsername = explicitTarget || player;

      if (explicitTarget) {
        await this.ensureGuildTarget(targetUsername, roastConfig);
      }

      const { username, stats } = await this.buildRoastStats(targetUsername);
      const result = evaluateRoast({
        stats,
        username,
        isSelf,
        configRoast: roastConfig,
        rng: Math.random
      });

      await this.send(result.message);
    } catch (error) {
      console.error(error);
      await this.send(`[ERROR] ${error}`);
    }
  }
}

module.exports = RoastCommand;
