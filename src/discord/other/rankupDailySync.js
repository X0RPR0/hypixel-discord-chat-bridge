const cron = require("node-cron");
const config = require("../../../config.json");
const { getRankupConfig, getBotGuildSnapshot, rankupAll } = require("../../contracts/rankupService.js");

const rankupConfig = getRankupConfig();

if (rankupConfig.enabled && rankupConfig.dailySync.enabled) {
  const hour = Number(rankupConfig.dailySync.hour ?? 3);
  const minute = Number(rankupConfig.dailySync.minute ?? 0);
  const expression = `${minute} ${hour} * * *`;

  console.discord(`Rankup daily sync ready, executing at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${config.other.timezone}).`);
  cron.schedule(
    expression,
    async () => {
      try {
        const guild = await getBotGuildSnapshot();
        const summary = await rankupAll({ guild, triggerRoleSync: false });
        console.discord(
          `Rankup daily sync finished. Checked: ${summary.checked}, Updated: ${summary.updated}, Unchanged: ${summary.unchanged}, Protected: ${summary.skippedProtected}, Failed: ${summary.failed}.`
        );
      } catch (error) {
        console.error(error);
      }
    },
    { timezone: config.other.timezone }
  );
}
