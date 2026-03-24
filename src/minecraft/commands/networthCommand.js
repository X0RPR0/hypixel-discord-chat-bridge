const { getLatestProfile } = require("../../../API/functions/getLatestProfile.js");
const { getMuseum } = require("../../../API/functions/getMuseum.js");
const minecraftCommand = require("../../contracts/minecraftCommand.js");
const { formatNumber } = require("../../contracts/helperFunctions.js");
const { ProfileNetworthCalculator } = require("skyhelper-networth");

class NetWorthCommand extends minecraftCommand {
  /** @param {import("minecraft-protocol").Client} minecraft */
  constructor(minecraft) {
    super(minecraft);

    this.name = "networth";
    this.aliases = ["nw"];
    this.description = "Networth of specified user.";
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
  }

  async getProfileNetworth({ profileData, uuid }) {
    const profileMember = profileData?.members?.[uuid];
    if (!profileMember) {
      throw "Could not find player in selected profile.";
    }

    const museumResponse = await getMuseum(profileData.profile_id, uuid).catch(() => ({ museum: null }));
    const bankingBalance = profileData?.banking?.balance ?? 0;

    const networthManager = new ProfileNetworthCalculator(profileMember, museumResponse.museum, bankingBalance);
    const networthData = await networthManager.getNetworth({ onlyNetworth: true });

    return {
      networthData,
      profileData,
      profileMember
    };
  }

  /**
   * @param {string} player
   * @param {string} message
   * */
  async onCommand(player, message) {
    try {
      const args = this.getArgs(message);
      const firstArg = args[0];
      const secondArg = args[1];

      const targetUsername = !firstArg || firstArg === "-" ? player : firstArg;
      const requestedProfile = ((firstArg === "-" ? secondArg : secondArg) || "latest").toLowerCase();

      const latestData = await getLatestProfile(targetUsername);
      const { username, uuid } = latestData;
      const allProfiles = Array.isArray(latestData.profiles) ? latestData.profiles : [];
      if (allProfiles.length === 0) {
        throw "Player has no SkyBlock profiles.";
      }

      let selected = null;
      let selectedProfileName = null;

      if (requestedProfile === "highest") {
        const results = [];
        for (const profileData of allProfiles) {
          const profileName = profileData?.cute_name || "Unknown";
          const result = await this.getProfileNetworth({ profileData, uuid }).catch(() => null);
          if (!result || result.networthData?.noInventory) {
            continue;
          }

          results.push({
            ...result,
            profileName
          });
        }

        if (results.length === 0) {
          return this.send(`${username} has an Inventory API off on all profiles.`);
        }

        selected = results.sort((a, b) => (b.networthData?.networth || 0) - (a.networthData?.networth || 0))[0];
        selectedProfileName = selected.profileName;
      } else {
        let profileData = null;
        if (requestedProfile === "latest") {
          profileData = allProfiles.find((entry) => entry.selected) || allProfiles[0];
        } else {
          profileData = allProfiles.find((entry) => String(entry?.cute_name || "").toLowerCase() === requestedProfile);
          if (!profileData) {
            const availableProfiles = allProfiles.map((entry) => entry?.cute_name).filter(Boolean).join(", ");
            throw `Profile \`${requestedProfile}\` not found. Available: ${availableProfiles || "none"}`;
          }
        }

        const result = await this.getProfileNetworth({ profileData, uuid });
        if (result.networthData?.noInventory === true) {
          return this.send(`${username} has an Inventory API off on profile ${profileData.cute_name || "Unknown"}.`);
        }

        selected = {
          ...result,
          profileName: profileData.cute_name || "Unknown"
        };
        selectedProfileName = selected.profileName;
      }

      const { networthData, profileData, profileMember } = selected;
      const networth = formatNumber(networthData.networth);
      const purse = formatNumber(networthData.purse);
      const bank = profileData.banking?.balance ? formatNumber(profileData.banking.balance) : "N/A";
      const personalBank = profileMember?.profile?.bank_account ? formatNumber(profileMember.profile.bank_account) : "N/A";

      this.send(`${username}'s Networth (${selectedProfileName}) is ${networth} | Purse: ${purse} | Bank: ${bank} + ${personalBank} |`);
    } catch (error) {
      console.error(error);
      this.send(`[ERROR] ${error}`);
    }
  }
}

module.exports = NetWorthCommand;
