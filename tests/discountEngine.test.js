const fs = require("fs");
const path = require("path");
const { CarryDatabase } = require("../src/discord/other/carryDatabase.js");
const DiscountEngine = require("../src/discord/other/discountEngine.js");

function makeDb(testName) {
  const dbPath = path.join("data", `${testName}.sqlite`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new CarryDatabase(dbPath);
  return db.initialize().then(() => ({ db, dbPath }));
}

describe("DiscountEngine", () => {
  test("timed carry discount overrides static global", async () => {
    const { db, dbPath } = await makeDb("discount-engine-1");
    const conn = db.getConnection();

    conn.prepare("INSERT INTO discount_rules (kind, scope, min_amount, percentage, active, created_at) VALUES ('static', 'global', 2, 10, 1, ?)").run(Date.now());

    const now = Date.now();
    conn
      .prepare(
        "INSERT INTO discount_rules (kind, scope, carry_type, tier, percentage, starts_at, ends_at, active, created_at) VALUES ('timed', 'carry', 'dungeons', 'f7', 25, ?, ?, 1, ?)"
      )
      .run(now - 1000, now + 100000, now);

    const engine = new DiscountEngine(db);
    const result = engine.calculate({
      unitPrice: 100,
      amount: 2,
      category: "dungeons",
      carryType: "dungeons",
      tier: "f7"
    });

    expect(result.scopeDiscount.source).toBe("timed");
    expect(result.scopeDiscount.percentage).toBe(25);
    expect(result.finalTotal).toBe(150);

    db.close();
    fs.unlinkSync(dbPath);
  });

  test("bulk stacks with one scope discount", async () => {
    const { db, dbPath } = await makeDb("discount-engine-2");
    const conn = db.getConnection();

    conn.prepare("INSERT INTO discount_rules (kind, scope, min_amount, percentage, active, created_at) VALUES ('static', 'global', 3, 10, 1, ?)").run(Date.now());

    conn
      .prepare("INSERT INTO discount_rules (kind, scope, category, min_amount, percentage, active, created_at) VALUES ('bulk', 'category', 'dungeons', 3, 5, 1, ?)")
      .run(Date.now());

    const engine = new DiscountEngine(db);
    const result = engine.calculate({
      unitPrice: 100,
      amount: 3,
      category: "dungeons",
      carryType: "dungeons",
      tier: "f7"
    });

    expect(result.totalPct).toBe(15);
    expect(result.finalTotal).toBe(255);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
