/* eslint-env jest */
jest.mock("../src/contracts/API/HypixelRebornAPI.js", () => ({
  getGuild: jest.fn(),
  getPlayer: jest.fn()
}));

const command = require("../src/discord/commands/checkActivityCommand.js");

describe("checkActivity helpers", () => {
  const { getStatus, getDaysSince, sortItems, applyStatusFilter } = command._private;

  test("classifies status boundaries correctly", () => {
    const now = Date.UTC(2026, 2, 24, 12, 0, 0);
    const day = 24 * 60 * 60 * 1000;

    expect(getStatus(now - 6 * day, now, { inactiveDays: 14, warningDays: 7 })).toBe("ACTIVE");
    expect(getStatus(now - 7 * day, now, { inactiveDays: 14, warningDays: 7 })).toBe("WARNING");
    expect(getStatus(now - 13 * day, now, { inactiveDays: 14, warningDays: 7 })).toBe("WARNING");
    expect(getStatus(now - 14 * day, now, { inactiveDays: 14, warningDays: 7 })).toBe("INACTIVE");
    expect(getStatus(null, now, { inactiveDays: 14, warningDays: 7 })).toBe("WARNING");
  });

  test("sorts by status severity and inactivity by default", () => {
    const input = [
      { username: "C", status: "ACTIVE", daysSinceLogin: 1, weeklyExperience: 10, chat30d: 1, playtime30dSeconds: 100 },
      { username: "B", status: "INACTIVE", daysSinceLogin: 20, weeklyExperience: 20, chat30d: 2, playtime30dSeconds: 200 },
      { username: "A", status: "WARNING", daysSinceLogin: 10, weeklyExperience: 30, chat30d: 3, playtime30dSeconds: 300 }
    ];

    const output = sortItems(input, "status");
    expect(output.map((item) => item.username)).toEqual(["B", "A", "C"]);
  });

  test("status filter keeps only requested tag", () => {
    const items = [{ status: "ACTIVE" }, { status: "WARNING" }, { status: "INACTIVE" }];

    expect(applyStatusFilter(items, "inactive")).toHaveLength(1);
    expect(applyStatusFilter(items, "all")).toHaveLength(3);
  });

  test("days since handles unknown timestamps", () => {
    expect(getDaysSince(null, Date.now())).toBeNull();
  });
});
