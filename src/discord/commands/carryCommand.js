const { ButtonStyle, SlashCommandBuilder } = require("discord.js");
const { actionButton, infoPayload, makePanel, panelPayload } = require("../other/componentsV2Panels.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("carry")
    .setDescription("Carry user commands")
    .addSubcommand((s) =>
      s
        .setName("request")
        .setDescription("Request a carry")
        .addStringOption((o) => o.setName("type").setDescription("Carry type").setRequired(true))
        .addStringOption((o) => o.setName("tier").setDescription("Tier").setRequired(true))
        .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1).setMaxValue(999))
    )
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Check carry status")
        .addIntegerOption((o) => o.setName("id").setDescription("Carry ID").setRequired(false).setMinValue(1))
    )
    .addSubcommand((s) => s.setName("free").setDescription("Check free carry balance"))
    .addSubcommand((s) => s.setName("mycarries").setDescription("Show your recent carry requests"))
    .addSubcommand((s) => s.setName("help").setDescription("Show carry user commands")),

  execute: async (interaction) => {
    const service = interaction.client.carryService;
    if (!service) {
      return interaction.editReply(infoPayload({ title: "Carry", status: "Error", lines: ["Carry service unavailable."] }));
    }

    const sub = interaction.options.getSubcommand();
    const coins = (value) => (typeof service?.formatCoinsShort === "function" ? service.formatCoinsShort(value) : String(Number(value || 0)));
    if (sub === "request") {
      const type = interaction.options.getString("type", true);
      const tier = interaction.options.getString("tier", true);
      const amount = interaction.options.getInteger("amount", true);
      const created = service.createCarryRequest({
        guildId: interaction.guildId,
        customerUser: interaction.user,
        member: interaction.member,
        carryType: type,
        tier,
        amount,
        source: "slash"
      });
      if (!created.ok) {
        return interaction.editReply(infoPayload({ title: "Carry Request Failed", status: "Error", lines: [created.reason] }));
      }

      const mins = Math.max(1, Math.round(created.eta.etaMs / 60000));
      return interaction.editReply(
        panelPayload(
          makePanel({
            title: `Carry #${created.carryId}`,
            status: "Queued",
            sections: [
              {
                title: "Summary",
                lines: [
                  `- Final: **${coins(created.finalPrice)}**`,
                  `- ETA: **~${mins}m**`,
                  `- Free Carry: **${
                    created.freeEligible
                      ? `yes (${created.freeSource || "weekly"})`
                      : created.freeBlockedByType
                        ? "no (excluded: Kuudra/M7)"
                        : created.freeBlockedByVerification
                          ? "no (verification required)"
                          : "no"
                  }**`
                ]
              }
            ],
            actions: [actionButton("carry:carry_refresh", "Refresh Dashboard", ButtonStyle.Secondary)]
          })
        )
      );
    }

    if (sub === "status") {
      const carryId = interaction.options.getInteger("id");
      let carry = null;
      if (carryId) {
        carry = service.getCarryById(carryId);
      } else {
        carry = service.db.getConnection().prepare("SELECT * FROM carries WHERE customer_discord_id = ? ORDER BY id DESC LIMIT 1").get(String(interaction.user.id));
      }

      if (!carry) {
        return interaction.editReply(infoPayload({ title: "Carry Status", status: "Not Found", lines: ["No carry found."] }));
      }

      if (String(carry.customer_discord_id) !== String(interaction.user.id)) {
        return interaction.editReply(infoPayload({ title: "Carry Status", status: "Denied", lines: ["You can only view your own carries."] }));
      }

      return interaction.editReply(
        panelPayload(
          makePanel({
            title: `Carry #${carry.id}`,
            status: String(carry.status),
            sections: [
              {
                title: "Order",
                lines: [
                  `- Type: **${carry.carry_type} ${carry.tier}**`,
                  `- Amount: **${carry.amount}**`,
                  `- Logged Runs: **${Number(carry.logged_runs || 0)}/${Number(carry.amount || 0)}**`
                ]
              },
              { title: "Payment", lines: [`- Final: **${coins(carry.final_price)}**`, `- Paid: **${coins(carry.paid_amount || 0)}**`] }
            ]
          })
        )
      );
    }

    if (sub === "free") {
      const status = service.getFreeCarryStatus(interaction.user.id);
      const verified = typeof service.isVerifiedForFreeCarry === "function" ? service.isVerifiedForFreeCarry(interaction.member, interaction.user.id) : false;
      return interaction.editReply(
        infoPayload({
          title: "Free Carry Balance",
          lines: [
            `Week: ${status.weekKey}`,
            `Verified: ${verified ? "yes" : "no"}`,
            `Weekly: ${status.weeklyRemaining}/${status.limit}`,
            `Bonus: ${status.bonusRemaining}`,
            `Total: ${status.totalRemaining}`,
            "Excluded: Kuudra, Dungeons M7"
          ]
        })
      );
    }

    if (sub === "mycarries") {
      const rows = service.db
        .getConnection()
        .prepare("SELECT id, carry_type, tier, amount, status, final_price, logged_runs FROM carries WHERE customer_discord_id = ? ORDER BY id DESC LIMIT 10")
        .all(String(interaction.user.id));
      if (!rows.length) {
        return interaction.editReply(infoPayload({ title: "My Carries", status: "Not Found", lines: ["No carries found."] }));
      }

      return interaction.editReply(
        panelPayload(
          makePanel({
            title: "My Carries",
            sections: [
              {
                title: "Recent Requests",
                lines: rows.map(
                  (r) =>
                    `- #${r.id} ${r.carry_type} ${r.tier} x${r.amount} | ${r.status} | runs ${Number(r.logged_runs || 0)}/${r.amount} | final ${coins(r.final_price)}`
                )
              }
            ]
          })
        )
      );
    }

    if (sub === "help") {
      return interaction.editReply(
        panelPayload(
          makePanel({
            title: "Carry Commands",
            sections: [
              {
                title: "User Commands",
                lines: [
                  "- `/carry request <type> <tier> <amount>`: Create a carry request and join the queue.",
                  "- `/carry status [id]`: Show your latest carry or a specific one.",
                  "- `/carry free`: Check weekly/bonus free carry availability.",
                  "- `/carry mycarries`: List your recent carries.",
                  "- `/carry help`: Show this help message."
                ]
              },
              {
                title: "Notes",
                lines: ["- In-game: `!carry request <type> <amount>` (linked Discord required).", "- Free carry exclusions: Kuudra and Dungeons M7."]
              }
            ]
          })
        )
      );
    }

    return interaction.editReply(infoPayload({ title: "Carry", status: "Error", lines: ["Unknown carry subcommand."] }));
  }
};
