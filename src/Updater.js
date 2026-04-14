const { exec } = require("child_process");
const config = require("./config");
const Logger = require("./Logger.js");
const cron = require("node-cron");

function isManagedMode() {
  const managed = String(process.env.CHATBRIDGE_MANAGED || "").toLowerCase();
  const disabled = String(process.env.CHATBRIDGE_DISABLE_INTERNAL_UPDATER || "").toLowerCase();
  return managed === "1" || managed === "true" || disabled === "1" || disabled === "true";
}

function updateCode() {
  if (isManagedMode()) {
    return;
  }

  if (config.other.autoUpdater === false) {
    return;
  }

  exec("git pull", (error, stdout, stderr) => {
    if (error) {
      console.error(error);
      return;
    }

    // console.log(`Git pull output: ${stdout}`);

    if (stdout === "Already up to date.\n") {
      return;
    }

    Logger.updateMessage();
  });
}

if (!isManagedMode()) {
  cron.schedule(`0 */${config.other.autoUpdaterInterval} * * *`, () => updateCode(), { timezone: config.other.timezone });
  updateCode();
}
