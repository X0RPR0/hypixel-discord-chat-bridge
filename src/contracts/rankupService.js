const HypixelDiscordChatBridgeError = require("./errorHandler.js");
const { getUUID, getUsername } = require("./API/mowojangAPI.js");
const hypixel = require("./API/HypixelRebornAPI.js");
const { getLatestProfile } = require("../../API/functions/getLatestProfile.js");
const { delay } = require("./helperFunctions.js");
const { getAllLinks, getDiscordIdByUuid, getUuidByDiscordId } = require("./linkedStore.js");
const config = require("../../config.json");

function getRankupConfig() {
  const defaults = {
    enabled: false,
    manual: {
      minecraftEnabled: true,
      discordEnabled: true
    },
    dailySync: {
      enabled: false,
      hour: 3,
      minute: 0
    },
    tiers: [
      { minSkyblockLevel: 300, guildRank: "Draconian" },
      { minSkyblockLevel: 150, guildRank: "Dusk" },
      { minSkyblockLevel: 0, guildRank: "Shadow" }
    ],
    allowedInvokerGuildRanks: ["Guild Master", "Slayer"],
    protectedGuildRanks: ["Guild Master", "Slayer"]
  };

  const rankup = config.rankup || {};
  return {
    enabled: rankup.enabled ?? defaults.enabled,
    manual: {
      minecraftEnabled: rankup.manual?.minecraftEnabled ?? defaults.manual.minecraftEnabled,
      discordEnabled: rankup.manual?.discordEnabled ?? defaults.manual.discordEnabled
    },
    dailySync: {
      enabled: rankup.dailySync?.enabled ?? defaults.dailySync.enabled,
      hour: rankup.dailySync?.hour ?? defaults.dailySync.hour,
      minute: rankup.dailySync?.minute ?? defaults.dailySync.minute
    },
    tiers: Array.isArray(rankup.tiers) && rankup.tiers.length > 0 ? rankup.tiers : defaults.tiers,
    allowedInvokerGuildRanks:
      Array.isArray(rankup.allowedInvokerGuildRanks) && rankup.allowedInvokerGuildRanks.length > 0 ? rankup.allowedInvokerGuildRanks : defaults.allowedInvokerGuildRanks,
    protectedGuildRanks: Array.isArray(rankup.protectedGuildRanks) && rankup.protectedGuildRanks.length > 0 ? rankup.protectedGuildRanks : defaults.protectedGuildRanks
  };
}

function getSortedTiers() {
  return [...getRankupConfig().tiers].sort((a, b) => Number(b.minSkyblockLevel) - Number(a.minSkyblockLevel));
}

function readLinkedData() {
  return getAllLinks();
}

function getSkyblockLevelFromMember(member) {
  return Math.floor(((member?.leveling?.experience ?? 0) || 0) / 100);
}

function getTargetGuildRank(skyblockLevel) {
  const tiers = getSortedTiers();
  return tiers.find((tier) => skyblockLevel >= Number(tier.minSkyblockLevel))?.guildRank ?? tiers.at(-1)?.guildRank ?? "Shadow";
}

async function getBotGuildSnapshot() {
  if (!bot?._client?.chat) {
    throw new HypixelDiscordChatBridgeError("Bot doesn't seem to be connected to Hypixel. Please try again.");
  }

  const guild = await hypixel.getGuild("player", bot.username, { noCaching: true, noCacheCheck: true });
  if (!guild) {
    throw new HypixelDiscordChatBridgeError("Failed to fetch guild data.");
  }

  return guild;
}

async function getHighestSkyblockLevel(uuid) {
  const profileData = await getLatestProfile(uuid);
  const profiles = Array.isArray(profileData?.profiles) ? profileData.profiles : [];
  let highestLevel = 0;

  for (const profile of profiles) {
    const member = profile?.members?.[uuid];
    const level = getSkyblockLevelFromMember(member);
    if (level > highestLevel) {
      highestLevel = level;
    }
  }

  return highestLevel;
}

async function getInvokerGuildRankByUsername(username, guild) {
  const uuid = await getUUID(username);
  const member = guild.members.find((m) => m.uuid === uuid);
  return member?.rank;
}

async function getInvokerGuildRankByDiscordId(discordId, guild) {
  const uuid = getUuidByDiscordId(discordId);
  if (!uuid) {
    throw new HypixelDiscordChatBridgeError("You are not linked to a Minecraft account.");
  }

  const member = guild.members.find((m) => m.uuid === uuid);
  if (!member) {
    throw new HypixelDiscordChatBridgeError("You are not in the guild.");
  }

  return member.rank;
}

function isAllowedInvokerRank(rank) {
  return getRankupConfig().allowedInvokerGuildRanks.includes(rank);
}

function isProtectedGuildRank(rank) {
  return getRankupConfig().protectedGuildRanks.includes(rank);
}

async function applyGuildRank(username, targetRank) {
  bot.chat(`/g setrank ${username} ${targetRank}`);
  await delay(300);
}

async function trySyncLinkedDiscordRoles(uuid) {
  const discordId = getDiscordIdByUuid(uuid);
  if (!discordId) {
    return { status: "skipped", reason: "No Discord link found." };
  }

  try {
    // Lazy require to avoid unnecessary module load in non-sync paths.
    const { updateRoles } = require("../discord/commands/updateCommand.js");
    await updateRoles({ discordId, uuid });
    return { status: "updated" };
  } catch (error) {
    return { status: "failed", reason: error?.message || String(error) };
  }
}

function formatFailure(username, reason) {
  return {
    status: "failed",
    username,
    reason
  };
}

async function rankupSingle({ username, guild, triggerRoleSync = false }) {
  try {
    const uuid = await getUUID(username);
    const guildMember = guild.members.find((member) => member.uuid === uuid);
    if (!guildMember) {
      return formatFailure(username, "Player is not in the guild.");
    }

    const skyblockLevel = await getHighestSkyblockLevel(uuid);
    const targetGuildRank = getTargetGuildRank(skyblockLevel);
    const currentGuildRank = guildMember.rank;

    if (isProtectedGuildRank(currentGuildRank)) {
      return {
        status: "skipped_protected",
        username,
        uuid,
        skyblockLevel,
        currentGuildRank,
        targetGuildRank,
        reason: "Player currently has a protected guild rank."
      };
    }

    if (currentGuildRank === targetGuildRank) {
      return {
        status: "unchanged",
        username,
        uuid,
        skyblockLevel,
        currentGuildRank,
        targetGuildRank
      };
    }

    await applyGuildRank(username, targetGuildRank);
    const roleSync = triggerRoleSync ? await trySyncLinkedDiscordRoles(uuid) : undefined;

    return {
      status: "updated",
      username,
      uuid,
      skyblockLevel,
      currentGuildRank,
      targetGuildRank,
      roleSync
    };
  } catch (error) {
    return formatFailure(username, error?.message || String(error));
  }
}

async function rankupSingleByUuid({ uuid, guild, triggerRoleSync = false }) {
  const username = await getUsername(uuid);
  return rankupSingle({ username, guild, triggerRoleSync });
}

async function rankupAll({ guild, triggerRoleSync = false, onProgress } = {}) {
  const results = [];
  const total = Array.isArray(guild?.members) ? guild.members.length : 0;
  let done = 0;

  for (const member of guild.members) {
    let username = member.uuid;
    try {
      username = await getUsername(member.uuid);
      const result = await rankupSingle({ username, guild, triggerRoleSync });
      results.push(result);

      done += 1;
      if (typeof onProgress === "function") {
        try {
          await onProgress({
            done,
            total,
            username,
            result,
            summary: summarizeResults(results)
          });
        } catch (progressError) {
          console.warn("Rankup progress callback failed:", progressError?.message || progressError);
        }
      }
    } catch (error) {
      const result = formatFailure(username, error?.message || String(error));
      results.push(result);

      done += 1;
      if (typeof onProgress === "function") {
        try {
          await onProgress({
            done,
            total,
            username,
            result,
            summary: summarizeResults(results)
          });
        } catch (progressError) {
          console.warn("Rankup progress callback failed:", progressError?.message || progressError);
        }
      }
    }
  }

  return summarizeResults(results);
}

function summarizeResults(results) {
  const summary = {
    checked: results.length,
    updated: results.filter((r) => r.status === "updated").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    skippedProtected: results.filter((r) => r.status === "skipped_protected").length,
    failed: results.filter((r) => r.status === "failed").length,
    results
  };

  return summary;
}

module.exports = {
  getRankupConfig,
  getBotGuildSnapshot,
  getInvokerGuildRankByUsername,
  getInvokerGuildRankByDiscordId,
  isAllowedInvokerRank,
  rankupSingle,
  rankupSingleByUuid,
  rankupAll,
  summarizeResults,
  readLinkedData
};
