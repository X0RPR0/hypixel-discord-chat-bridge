const fs = require("fs");
const path = require("path");
const { CarryDatabase } = require("../src/discord/other/carryDatabase.js");
const EtaEngine = require("../src/discord/other/etaEngine.js");

function makeDb(testName) {
  const dbPath = path.join("data", `${testName}.sqlite`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new CarryDatabase(dbPath);
  return db.initialize().then(() => ({ db, dbPath }));
}

describe("EtaEngine", () => {
  test("returns finite ETA with factors", async () => {
    const { db, dbPath } = await makeDb("eta-engine");
    const eta = new EtaEngine(db).estimate({
      carryType: "dungeons",
      tier: "f7",
      queueDepth: 5,
      activeCarrierCount: 3,
      onlineCarrierCount: 2,
      acceptanceRate: 0.75
    });

    expect(Number.isFinite(eta.etaMs)).toBe(true);
    expect(eta.etaMs).toBeGreaterThan(0);
    expect(eta.factors.carriers).toBeGreaterThan(0);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
