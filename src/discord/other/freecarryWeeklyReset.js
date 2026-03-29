const cron = require("node-cron");

let task = null;

function startWeeklyFreeCarryReset(carryService) {
  if (task) {
    task.stop();
    task.destroy();
  }

  task = cron.schedule(
    "0 0 * * 1",
    () => {
      carryService.resetFreeCarryWeekly();
    },
    {
      timezone: "UTC"
    }
  );

  console.discord("Free carry weekly reset scheduler initialized (Monday 00:00 UTC).");
  return task;
}

function stopWeeklyFreeCarryReset() {
  if (!task) return;
  task.stop();
  task.destroy();
  task = null;
}

module.exports = {
  startWeeklyFreeCarryReset,
  stopWeeklyFreeCarryReset
};
