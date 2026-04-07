const fs = require("fs");
const path = require("path");
const { MessageFlags } = require("discord.js");
const { CarryDatabase } = require("../src/discord/other/carryDatabase.js");
const { CarryService } = require("../src/discord/other/carryService.js");

function makeDb(testName) {
  const dbPath = path.join("data", `${testName}.sqlite`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new CarryDatabase(dbPath);
  return db.initialize().then(() => ({ db, dbPath }));
}

describe("CarryService V2 panels", () => {
  test("carry dashboard panel is V2 payload and does not use embeds", async () => {
    const { db, dbPath } = await makeDb("carry-v2-panels");
    const service = new CarryService(db, null);
    service.seedDefaultCatalog();
    const payload = service.buildCarryDashboardPanel({ viewKey: "overview", page: 1 });

    expect(payload.embeds).toBeUndefined();
    expect(Array.isArray(payload.components)).toBe(true);
    expect(Number(payload.flags) & Number(MessageFlags.IsComponentsV2)).toBe(Number(MessageFlags.IsComponentsV2));

    db.close();
    fs.unlinkSync(dbPath);
  });

  test("execution panel actions are status-aware", async () => {
    const { db, dbPath } = await makeDb("carry-v2-status-actions");
    const service = new CarryService(db, null);

    const queuedActions = service.buildExecutionComponents({
      id: 1,
      status: "queued",
      assigned_carrier_discord_ids: "[]"
    });
    const inProgressActions = service.buildExecutionComponents({
      id: 2,
      status: "in_progress",
      assigned_carrier_discord_ids: JSON.stringify(["123"])
    });
    const completedActions = service.buildExecutionComponents({
      id: 3,
      status: "completed",
      assigned_carrier_discord_ids: JSON.stringify(["123"])
    });

    expect(queuedActions.map((a) => a.data.label)).toEqual(["Claim Carry", "Assign Carrier", "Cancel Request"]);
    expect(inProgressActions.map((a) => a.data.label)).toEqual(["Log Runs", "Mark Paid", "Unclaim", "Reassign", "Re-Ping Customer", "Close Ticket"]);
    expect(completedActions.map((a) => a.data.label)).toEqual(["View Logs", "Reopen"]);

    db.close();
    fs.unlinkSync(dbPath);
  });

  test("bulk actions require confirmation modal", async () => {
    const { db, dbPath } = await makeDb("carry-v2-bulk-confirm");
    const service = new CarryService(db, null);
    jest.spyOn(service, "isStaff").mockReturnValue(true);
    const showModal = jest.fn().mockResolvedValue(null);

    const handled = await service.handleComponent({
      customId: "carry:bulk:claim_next_3",
      member: {},
      showModal
    });

    expect(handled).toBe(true);
    expect(showModal).toHaveBeenCalledTimes(1);

    db.close();
    fs.unlinkSync(dbPath);
  });

  test("bulk modal rejects when confirmation phrase is invalid", async () => {
    const { db, dbPath } = await makeDb("carry-v2-bulk-reject");
    const service = new CarryService(db, null);
    jest.spyOn(service, "isStaff").mockReturnValue(true);
    const reply = jest.fn().mockResolvedValue(null);

    const handled = await service.handleModal({
      customId: "carrymodal:bulk:claim_next_3",
      member: {},
      fields: { getTextInputValue: () => "nope" },
      reply
    });

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledTimes(1);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
