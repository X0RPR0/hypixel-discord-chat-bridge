const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { ErrorEmbed, SuccessEmbed } = require("../../contracts/embedHandler.js");

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
      return interaction.editReply({ embeds: [new ErrorEmbed("Carry service unavailable.")] });
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
        return interaction.editReply({ embeds: [new ErrorEmbed(created.reason)] });
      }

      const mins = Math.max(1, Math.round(created.eta.etaMs / 60000));
      return interaction.editReply({
        embeds: [
          new SuccessEmbed(
            `Carry #${created.carryId} queued.\nFinal: \`${coins(created.finalPrice)}\`\nETA: \`~${mins}m\`\nFree carry: \`${created.freeEligible ? `yes (${created.freeSource || "weekly"})` : "no"}\``
          )
        ]
      });
    }

    if (sub === "status") {
      const carryId = interaction.options.getInteger("id");
      let carry = null;
      if (carryId) {
        carry = service.getCarryById(carryId);
      } else {
        carry = service
          .db
          .getConnection()
          .prepare("SELECT * FROM carries WHERE customer_discord_id = ? ORDER BY id DESC LIMIT 1")
          .get(String(interaction.user.id));
      }

      if (!carry) {
        return interaction.editReply({ embeds: [new ErrorEmbed("No carry found.")] });
      }

      if (String(carry.customer_discord_id) !== String(interaction.user.id)) {
        return interaction.editReply({ embeds: [new ErrorEmbed("You can only view your own carries.")] });
      }

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle(`Carry #${carry.id}`)
            .setDescription(`Type: **${carry.carry_type} ${carry.tier}**`)
            .addFields(
              { name: "Status", value: String(carry.status), inline: true },
              { name: "Amount", value: String(carry.amount), inline: true },
              { name: "Logged Runs", value: `${Number(carry.logged_runs || 0)}/${Number(carry.amount || 0)}`, inline: true },
              { name: "Final", value: coins(carry.final_price), inline: true },
              { name: "Paid", value: coins(carry.paid_amount || 0), inline: true }
            )
        ]
      });
    }

    if (sub === "free") {
      const status = service.getFreeCarryStatus(interaction.user.id);
      return interaction.editReply({
        embeds: [
          new SuccessEmbed(
            `Week: \`${status.weekKey}\`\nWeekly: \`${status.weeklyRemaining}/${status.limit}\`\nBonus: \`${status.bonusRemaining}\`\nTotal available: \`${status.totalRemaining}\``
          )
        ]
      });
    }

    if (sub === "mycarries") {
      const rows = service
        .db
        .getConnection()
        .prepare("SELECT id, carry_type, tier, amount, status, final_price, logged_runs FROM carries WHERE customer_discord_id = ? ORDER BY id DESC LIMIT 10")
        .all(String(interaction.user.id));
      if (!rows.length) {
        return interaction.editReply({ embeds: [new ErrorEmbed("No carries found.")] });
      }

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("My Carries")
            .setDescription(
              rows.map((r) => `#${r.id} ${r.carry_type} ${r.tier} x${r.amount} | ${r.status} | runs ${Number(r.logged_runs || 0)}/${r.amount} | final ${coins(r.final_price)}`).join("\n")
            )
        ]
      });
    }

    if (sub === "help") {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("Carry Commands")
            .setDescription("User-facing carry commands:")
            .addFields(
              { name: "/carry request <type> <tier> <amount>", value: "Create a carry request and join the queue." },
              { name: "/carry status [id]", value: "Show your latest carry or a specific one." },
              { name: "/carry free", value: "Check weekly/bonus free carry availability." },
              { name: "/carry mycarries", value: "List your recent carries." },
              { name: "/carry help", value: "Show this help message." }
            )
        ]
      });
    }

    return interaction.editReply({ embeds: [new ErrorEmbed("Unknown carry subcommand.")] });
  }
};
