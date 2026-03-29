const fs = require("fs");
const path = require("path");
const { CarryDatabase } = require("../src/discord/other/carryDatabase.js");
const { CarryService } = require("../src/discord/other/carryService.js");

function makeDb(testName) {
  const dbPath = path.join("data", `${testName}.sqlite`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new CarryDatabase(dbPath);
  return db.initialize().then(() => ({ db, dbPath }));
}

describe("Free carry weekly limit", () => {
  test("consumes weekly quota", async () => {
    const { db, dbPath } = await makeDb("freecarry-limit");
    const service = new CarryService(db, null);

    service.setFreeCarryLimit(1);
    expect(service.canUseFreeCarry("user-1")).toBe(true);
    service.consumeFreeCarry("user-1");
    expect(service.canUseFreeCarry("user-1")).toBe(false);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
