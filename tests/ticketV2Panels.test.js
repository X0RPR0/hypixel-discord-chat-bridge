const fs = require("fs");
const path = require("path");
const { MessageFlags } = require("discord.js");
const { CarryDatabase } = require("../src/discord/other/carryDatabase.js");
const { TicketService } = require("../src/discord/other/ticketService.js");

function makeDb(testName) {
  const dbPath = path.join("data", `${testName}.sqlite`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new CarryDatabase(dbPath);
  return db.initialize().then(() => ({ db, dbPath }));
}

describe("TicketService V2 panels", () => {
  test("dashboard panel is V2 and contains no embeds", async () => {
    const { db, dbPath } = await makeDb("ticket-v2-panels");
    const service = new TicketService(db);
    const payload = {
      ...require("../src/discord/other/componentsV2Panels.js").panelPayload(service.buildDashboardPanel({ viewKey: "open", page: 1, expanded: [] }))
    };

    expect(payload.embeds).toBeUndefined();
    expect(Array.isArray(payload.components)).toBe(true);
    expect(Number(payload.flags) & Number(MessageFlags.IsComponentsV2)).toBe(Number(MessageFlags.IsComponentsV2));

    db.close();
    fs.unlinkSync(dbPath);
  });

  test("dashboard component interactions persist actor state (view/page/expanded)", async () => {
    const { db, dbPath } = await makeDb("ticket-v2-state");
    const service = new TicketService(db);
    const conn = db.getConnection();
    conn
      .prepare("INSERT INTO tickets (guild_id, type, title, status, customer_discord_id, customer_username, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("g1", "general", "General Ticket", "open", "1001", "user", Date.now());

    const update = jest.fn().mockResolvedValue(null);
    const showModal = jest.fn().mockResolvedValue(null);

    await service.handleComponent({
      customId: "ticket:view:dashboard:open",
      message: { id: "msg-1" },
      user: { id: "actor-1" },
      update
    });
    await service.handleComponent({
      customId: "ticket:page:dashboard:2",
      message: { id: "msg-1" },
      user: { id: "actor-1" },
      update
    });
    await service.handleComponent({
      customId: "ticket:toggle:dashboard:show_logs",
      message: { id: "msg-1" },
      user: { id: "actor-1" },
      update
    });
    await service.handleComponent({
      customId: "ticket:jump:dashboard",
      message: { id: "msg-1" },
      user: { id: "actor-1" },
      showModal
    });

    const state = db.getUiPanelState({
      panelScope: "ticket_dashboard",
      messageId: "msg-1",
      actorId: "actor-1",
      fallback: null
    });

    expect(state).not.toBeNull();
    expect(state.viewKey).toBe("open");
    expect(state.page).toBe(2);
    expect(state.expanded).toContain("logs");
    expect(update).toHaveBeenCalled();
    expect(showModal).toHaveBeenCalled();

    db.close();
    fs.unlinkSync(dbPath);
  });

  test("jump modal applies page while preserving view and expanded state", async () => {
    const { db, dbPath } = await makeDb("ticket-v2-jump");
    const service = new TicketService(db);
    service.setPanelState("msg-2", "actor-2", { viewKey: "pending", page: 1, expanded: ["audit"] });
    service.publishDashboard = jest.fn().mockResolvedValue(null);

    const deferReply = jest.fn().mockResolvedValue(null);
    const editReply = jest.fn().mockResolvedValue(null);
    await service.handleModal({
      customId: "ticket:modal:jump:dashboard:msg-2",
      user: { id: "actor-2" },
      fields: { getTextInputValue: () => "4" },
      deferReply,
      editReply
    });

    const state = service.getPanelState("msg-2", "actor-2");
    expect(state.viewKey).toBe("pending");
    expect(state.page).toBe(4);
    expect(state.expanded).toEqual(["audit"]);
    expect(service.publishDashboard).toHaveBeenCalled();

    db.close();
    fs.unlinkSync(dbPath);
  });
});
