const { readFileSync } = require("fs");
const { carryDatabase } = require("../discord/other/carryDatabase.js");

const MIGRATION_BINDING_KEY = "linked_accounts_migrated_from_json";

function readLegacyLinkedJson() {
  try {
    const raw = readFileSync("data/linked.json", "utf8");
    if (!raw || raw.trim().length === 0) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getConnection() {
  try {
    return carryDatabase.getConnection();
  } catch {
    return null;
  }
}

function ensureMigrated(connection) {
  const migrated = carryDatabase.getBinding(MIGRATION_BINDING_KEY, "0");
  if (String(migrated) === "1") {
    return;
  }

  const legacy = readLegacyLinkedJson();
  const entries = Object.entries(legacy).filter(([uuid, discordId]) => uuid && discordId);

  const runMigration = connection.transaction(() => {
    for (const [uuid, discordId] of entries) {
      const uuidKey = String(uuid);
      const discordKey = String(discordId);
      connection.prepare("DELETE FROM linked_accounts WHERE uuid = ? OR discord_id = ?").run(uuidKey, discordKey);
      connection.prepare("INSERT INTO linked_accounts (uuid, discord_id, updated_at) VALUES (?, ?, ?)").run(uuidKey, discordKey, Date.now());
    }
  });

  runMigration();
  carryDatabase.setBinding(MIGRATION_BINDING_KEY, "1");
}

function getAllLinks() {
  const connection = getConnection();
  if (!connection) {
    return readLegacyLinkedJson();
  }

  ensureMigrated(connection);
  const rows = connection.prepare("SELECT uuid, discord_id FROM linked_accounts").all();
  const output = {};
  for (const row of rows) {
    output[String(row.uuid)] = String(row.discord_id);
  }

  return output;
}

function getDiscordIdByUuid(uuid) {
  const key = String(uuid || "").trim();
  if (!key) return null;

  const connection = getConnection();
  if (!connection) {
    const fallback = readLegacyLinkedJson();
    return fallback[key] ? String(fallback[key]) : null;
  }

  ensureMigrated(connection);
  const row = connection.prepare("SELECT discord_id FROM linked_accounts WHERE uuid = ?").get(key);
  return row?.discord_id ? String(row.discord_id) : null;
}

function getUuidByDiscordId(discordId) {
  const key = String(discordId || "").trim();
  if (!key) return null;

  const connection = getConnection();
  if (!connection) {
    const fallback = readLegacyLinkedJson();
    return Object.entries(fallback).find(([, id]) => String(id) === key)?.[0] || null;
  }

  ensureMigrated(connection);
  const row = connection.prepare("SELECT uuid FROM linked_accounts WHERE discord_id = ?").get(key);
  return row?.uuid ? String(row.uuid) : null;
}

function upsertLink(uuid, discordId) {
  const uuidKey = String(uuid || "").trim();
  const discordKey = String(discordId || "").trim();
  if (!uuidKey || !discordKey) {
    return false;
  }

  const connection = getConnection();
  if (!connection) {
    return false;
  }

  ensureMigrated(connection);
  const run = connection.transaction(() => {
    connection.prepare("DELETE FROM linked_accounts WHERE uuid = ? OR discord_id = ?").run(uuidKey, discordKey);
    connection.prepare("INSERT INTO linked_accounts (uuid, discord_id, updated_at) VALUES (?, ?, ?)").run(uuidKey, discordKey, Date.now());
  });
  run();

  return true;
}

function removeLinkByDiscordId(discordId) {
  const key = String(discordId || "").trim();
  if (!key) return false;

  const connection = getConnection();
  if (!connection) {
    return false;
  }

  ensureMigrated(connection);
  connection.prepare("DELETE FROM linked_accounts WHERE discord_id = ?").run(key);
  return true;
}

function getAllDiscordIds() {
  const connection = getConnection();
  if (!connection) {
    return Object.values(readLegacyLinkedJson()).map((value) => String(value));
  }

  ensureMigrated(connection);
  return connection
    .prepare("SELECT discord_id FROM linked_accounts")
    .all()
    .map((row) => String(row.discord_id));
}

module.exports = {
  getAllLinks,
  getDiscordIdByUuid,
  getUuidByDiscordId,
  upsertLink,
  removeLinkByDiscordId,
  getAllDiscordIds
};
