const fs = require("fs");
const path = require("path");

const configPath = path.resolve(process.cwd(), "config.json");
const exampleConfigPath = path.resolve(process.cwd(), "config.example.json");
const roastConfigPath = path.resolve(process.cwd(), "roastConfig.json");

if (!fs.existsSync(configPath) && fs.existsSync(exampleConfigPath)) {
  const exampleConfig = JSON.parse(fs.readFileSync(exampleConfigPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2));
}

if (!fs.existsSync(roastConfigPath)) {
  fs.writeFileSync(roastConfigPath, JSON.stringify({}, null, 2));
}
