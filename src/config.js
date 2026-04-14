const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const CACHE_TTL_MS = 500;

let cachedConfig = null;
let cachedMtimeMs = 0;
let cachedAt = 0;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readConfigFromDisk() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

function loadConfig(force = false) {
  const now = Date.now();
  if (!force && cachedConfig && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  let stat;
  try {
    stat = fs.statSync(CONFIG_PATH);
  } catch {
    return cachedConfig || {};
  }

  if (!force && cachedConfig && stat.mtimeMs === cachedMtimeMs) {
    cachedAt = now;
    return cachedConfig;
  }

  try {
    const next = readConfigFromDisk();
    cachedConfig = next && typeof next === "object" ? next : {};
    cachedMtimeMs = stat.mtimeMs;
    cachedAt = now;
  } catch {
    if (!cachedConfig) cachedConfig = {};
    cachedAt = now;
  }

  return cachedConfig;
}

function getConfig(pathValue, fallback) {
  const cfg = loadConfig(false);
  if (!pathValue) return cfg;

  const value = String(pathValue)
    .split(".")
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), cfg);

  return value === undefined ? fallback : value;
}

function reloadConfig() {
  return clone(loadConfig(true)) || {};
}

function createLiveProxy(pathParts = []) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const currentValue = getConfig(pathParts.join("."));
        if (prop === "__raw") return currentValue;
        if (prop === "toJSON") return () => currentValue;
        if (prop === Symbol.toPrimitive) return () => String(currentValue);
        if (prop === Symbol.iterator) return currentValue?.[Symbol.iterator]?.bind(currentValue);

        if (!currentValue || typeof currentValue !== "object") {
          return undefined;
        }

        if (!(prop in currentValue)) {
          return undefined;
        }

        const nextValue = currentValue[prop];
        if (typeof nextValue === "function") {
          return nextValue.bind(currentValue);
        }

        if (nextValue && typeof nextValue === "object") {
          return createLiveProxy([...pathParts, String(prop)]);
        }

        return nextValue;
      },
      ownKeys() {
        const value = getConfig(pathParts.join("."));
        if (value && typeof value === "object") return Reflect.ownKeys(value);
        return [];
      },
      getOwnPropertyDescriptor() {
        return {
          enumerable: true,
          configurable: true
        };
      },
      has(_target, prop) {
        const value = getConfig(pathParts.join("."));
        return !!(value && typeof value === "object" && prop in value);
      }
    }
  );
}

const liveConfig = createLiveProxy();

module.exports = liveConfig;
module.exports.getConfig = getConfig;
module.exports.reloadConfig = reloadConfig;
module.exports.CONFIG_PATH = CONFIG_PATH;
