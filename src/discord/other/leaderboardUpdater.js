const leaderboardService = require("./leaderboardService.js");
const config = require("../../../config.json");
const cron = require("node-cron");

const interval = Math.max(1, Number(config?.discord?.leaderboard?.autoUpdateMinutes) || 15);

cron.schedule(
  `*/${interval} * * * *`,
  async () => {
    try {
      await leaderboardService.updateConfiguredMessage();
    } catch (error) {
      console.error(error);
    }
  },
  { timezone: config.other.timezone }
);

console.discord(`Leaderboard updater ready, executing every ${interval} minutes.`);
