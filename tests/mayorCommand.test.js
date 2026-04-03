/* eslint-env jest */

jest.mock("axios", () => ({
  get: jest.fn()
}));

const { get } = require("axios");
const command = require("../src/discord/commands/mayorCommand.js");

function createElectionData(overrides = {}) {
  return {
    success: true,
    mayor: {
      name: "Marina",
      perks: [{ name: "Fishing Festival" }, { name: "Fishing XP Buff" }],
      minister: { perk: { name: "Some Perk" } },
      election: {
        year: 500,
        candidates: [
          { name: "Aatrox", votes: 1000 },
          { name: "Marina", votes: 3000 }
        ]
      }
    },
    current: {
      year: 500
    },
    ...overrides
  };
}

describe("mayor command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("election field sorts candidates and includes progress bar", () => {
    const field = command._private.buildElectionField(createElectionData());
    expect(field.name).toContain("Current Election");
    expect(field.value.indexOf("Marina")).toBeLessThan(field.value.indexOf("Aatrox"));
    expect(field.value).toContain("[");
    expect(field.value).toContain("#");
  });

  test("shows scheduled events for marina", () => {
    const section = command._private.formatMayorEventSection(createElectionData().mayor, Date.now());
    expect(section).toContain("Next Event:");
    expect(section).toContain("Event 1:");
    expect(section).toContain("<t:");
  });

  test("hides event section for unrelated mayor perks", () => {
    const section = command._private.formatMayorEventSection(
      {
        name: "Paul",
        perks: [{ name: "Marauder" }]
      },
      Date.now()
    );
    expect(section).toBeNull();
  });

  test("rejects non-invoker button presses", async () => {
    get.mockResolvedValue({ data: createElectionData() });

    const handlers = {};
    const fakeCollector = {
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      })
    };
    const reply = {
      createMessageComponentCollector: jest.fn(() => fakeCollector)
    };

    const interaction = {
      id: "abc123",
      user: { id: "owner-id" },
      editReply: jest.fn(async () => reply)
    };

    await command.execute(interaction);

    const intruder = {
      user: { id: "intruder-id" },
      customId: `mayor:election:${interaction.id}`,
      reply: jest.fn(async () => {})
    };

    await handlers.collect(intruder);
    expect(intruder.reply).toHaveBeenCalledWith({
      content: "Only the command invoker can use these buttons.",
      ephemeral: true
    });
  });
});
