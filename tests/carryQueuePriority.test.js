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

describe("CarryService queue priority", () => {
  test("paid requests sort above free requests", async () => {
    const { db, dbPath } = await makeDb("carry-priority");
    const service = new CarryService(db, null);
    service.seedDefaultCatalog();
    service.setCarryEnabled("dungeons", true);
    service.setCarryPrice("dungeons", "f7", 100);

    service.createCarryRequest({
      guildId: "g1",
      customerUser: { id: "u-free", username: "free" },
      member: { roles: { cache: [] } },
      carryType: "dungeons",
      tier: "f7",
      amount: 1,
      isPaid: false,
      source: "test"
    });

    service.createCarryRequest({
      guildId: "g1",
      customerUser: { id: "u-paid", username: "paid" },
      member: { roles: { cache: [] } },
      carryType: "dungeons",
      tier: "f7",
      amount: 1,
      isPaid: true,
      source: "test"
    });

    const queue = service.getQueueRows();
    expect(queue.length).toBe(2);
    expect(queue[0].customer_discord_id).toBe("u-paid");

    db.close();
    fs.unlinkSync(dbPath);
  });
});
