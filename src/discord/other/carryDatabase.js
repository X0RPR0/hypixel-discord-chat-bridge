const initSqlJs = require("sql.js");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const path = require("path");

class StatementWrapper {
  constructor(connection, sql) {
    this.connection = connection;
    this.sql = sql;
  }

  run(...params) {
    const stmt = this.connection.db.prepare(this.sql);
    try {
      stmt.run(params);
    } finally {
      stmt.free();
    }

    const info = {
      lastInsertRowid: Number(this.connection.scalar("SELECT last_insert_rowid()") || 0),
      changes: Number(this.connection.scalar("SELECT changes()") || 0)
    };

    if (!/^\s*select/i.test(this.sql) && !this.connection.inTransaction) {
      this.connection.persist();
    }

    return info;
  }

  get(...params) {
    const stmt = this.connection.db.prepare(this.sql);
    try {
      if (params.length) {
        stmt.bind(params);
      }

      if (!stmt.step()) {
        return undefined;
      }

      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  all(...params) {
    const stmt = this.connection.db.prepare(this.sql);
    const rows = [];
    try {
      if (params.length) {
        stmt.bind(params);
      }

      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }
}

class ConnectionWrapper {
  constructor(owner, db) {
    this.owner = owner;
    this.db = db;
    this.inTransaction = false;
  }

  prepare(sql) {
    return new StatementWrapper(this, sql);
  }

  exec(sql) {
    this.db.exec(sql);
    if (!this.inTransaction) {
      this.persist();
    }
  }

  pragma() {
    // sql.js does not expose pragma helpers in the same way; noop for compatibility.
  }

  transaction(fn) {
    return (...args) => {
      this.db.exec("BEGIN");
      this.inTransaction = true;
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        this.inTransaction = false;
        this.persist();
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        this.inTransaction = false;
        throw error;
      }
    };
  }

  scalar(sql) {
    const row = this.prepare(sql).get();
    if (!row) return null;
    const firstKey = Object.keys(row)[0];
    return row[firstKey];
  }

  persist() {
    this.owner.persist();
  }
}

class CarryDatabase {
  constructor(dbPath = "data/carry_system.sqlite") {
    this.dbPath = dbPath;
    this.absolutePath = path.resolve(process.cwd(), dbPath);
    this.sqliteDb = null;
    this.connection = null;
    this.initialized = false;
    this.initializingPromise = null;
  }

  async initialize() {
    if (this.initialized) {
      return this.connection;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.initializingPromise = (async () => {
      const dir = path.dirname(this.absolutePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const SQL = await initSqlJs();
      const buffer = existsSync(this.absolutePath) ? readFileSync(this.absolutePath) : null;
      this.sqliteDb = buffer ? new SQL.Database(buffer) : new SQL.Database();
      this.connection = new ConnectionWrapper(this, this.sqliteDb);

      this.runMigrations();
      this.initialized = true;
      return this.connection;
    })();

    return this.initializingPromise;
  }

  runMigrations() {
    const db = this.connection;
    const tryExec = (sql) => {
      try {
        db.exec(sql);
      } catch {}
    };

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS setup_bindings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        type TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        customer_discord_id TEXT,
        customer_username TEXT,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        forum_thread_id TEXT,
        dashboard_message_id TEXT,
        reopen_count INTEGER NOT NULL DEFAULT 0,
        assigned_customer_discord_id TEXT,
        assigned_carrier_discord_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        author_discord_id TEXT,
        author_username TEXT,
        content TEXT,
        via_webhook INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS carries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER,
        guild_id TEXT,
        customer_discord_id TEXT,
        customer_mc_username TEXT,
        carry_type TEXT NOT NULL,
        tier TEXT NOT NULL,
        category TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        base_unit_price REAL NOT NULL,
        base_total_price REAL NOT NULL,
        final_price REAL NOT NULL,
        discount_total REAL NOT NULL,
        is_free INTEGER NOT NULL DEFAULT 0,
        is_paid INTEGER NOT NULL DEFAULT 0,
        price_breakdown_json TEXT NOT NULL DEFAULT '{}',
        requested_at INTEGER NOT NULL,
        queued_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        cancelled_at INTEGER,
        assigned_carrier_discord_ids TEXT NOT NULL DEFAULT '[]',
        carrier_confirmed INTEGER NOT NULL DEFAULT 0,
        customer_confirmed INTEGER NOT NULL DEFAULT 0,
        execution_channel_id TEXT,
        FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS queue_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        carry_id INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL,
        priority_score REAL NOT NULL,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        claimed_by_discord_id TEXT,
        stale_notified INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(carry_id) REFERENCES carries(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS carry_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        carry_type TEXT NOT NULL,
        tier TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(carry_type, tier)
      );

      CREATE TABLE IF NOT EXISTS role_priorities (
        role_id TEXT PRIMARY KEY,
        value REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discount_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        category TEXT,
        carry_type TEXT,
        tier TEXT,
        min_amount INTEGER,
        percentage REAL NOT NULL,
        starts_at INTEGER,
        ends_at INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS freecarry_usage (
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        used_count INTEGER NOT NULL,
        PRIMARY KEY(user_id, week_key)
      );

      CREATE TABLE IF NOT EXISTS freecarry_bonus (
        user_id TEXT PRIMARY KEY,
        remaining_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS carrier_stats (
        user_id TEXT PRIMARY KEY,
        completed_count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        acceptance_rate REAL NOT NULL DEFAULT 0,
        active_hours_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customer_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        carry_id INTEGER NOT NULL,
        customer_discord_id TEXT,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(carry_id) REFERENCES carries(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS account_links_cache (
        mc_username TEXT PRIMARY KEY,
        uuid TEXT,
        discord_id TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS carrier_online_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sampled_at INTEGER NOT NULL,
        online_count INTEGER NOT NULL
      );
    `);

    tryExec("ALTER TABLE carries ADD COLUMN logged_runs INTEGER NOT NULL DEFAULT 0;");
    tryExec("ALTER TABLE carries ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0;");
    tryExec("ALTER TABLE carries ADD COLUMN reping_last_at INTEGER;");
    tryExec("ALTER TABLE carries ADD COLUMN confirm_message_id TEXT;");
    tryExec("ALTER TABLE carries ADD COLUMN rating_message_id TEXT;");
    tryExec("ALTER TABLE carries ADD COLUMN execution_message_id TEXT;");
    tryExec("ALTER TABLE carries ADD COLUMN pending_log_runs INTEGER NOT NULL DEFAULT 0;");
    tryExec("ALTER TABLE carries ADD COLUMN pending_log_actor_id TEXT;");
    tryExec("ALTER TABLE carrier_stats ADD COLUMN completed_tickets_count INTEGER NOT NULL DEFAULT 0;");
    tryExec("ALTER TABLE carrier_stats ADD COLUMN actual_carries_count INTEGER NOT NULL DEFAULT 0;");
    tryExec("ALTER TABLE carrier_stats ADD COLUMN score_total REAL NOT NULL DEFAULT 0;");

    const schemaVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    if (!schemaVersion) {
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')").run();
    }
  }

  getConnection() {
    if (!this.initialized || !this.connection) {
      throw new Error("CarryDatabase is not initialized. Call initialize() first.");
    }

    return this.connection;
  }

  persist() {
    if (!this.sqliteDb) return;
    const data = this.sqliteDb.export();
    writeFileSync(this.absolutePath, Buffer.from(data));
  }

  close() {
    if (this.sqliteDb) {
      this.persist();
      this.sqliteDb.close();
    }

    this.sqliteDb = null;
    this.connection = null;
    this.initialized = false;
    this.initializingPromise = null;
  }

  setBinding(key, value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    this.getConnection().prepare("INSERT INTO setup_bindings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, serialized);
  }

  getBinding(key, fallback = null) {
    const row = this.getConnection().prepare("SELECT value FROM setup_bindings WHERE key = ?").get(key);
    if (!row) {
      return fallback;
    }

    const raw = row.value;
    if (raw === null || raw === undefined || raw === "") {
      return fallback;
    }

    const text = String(raw).trim();
    // Keep Discord snowflakes and other integer-like IDs as strings to avoid precision loss.
    if (/^-?\d+$/.test(text)) {
      return text;
    }

    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  logEvent(eventType, entityType, entityId, payload = {}) {
    this.getConnection()
      .prepare("INSERT INTO events (event_type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(eventType, entityType, String(entityId), JSON.stringify(payload || {}), Date.now());
  }
}

module.exports = {
  CarryDatabase,
  carryDatabase: new CarryDatabase()
};
