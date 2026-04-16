const { existsSync, readFileSync, writeFileSync } = require("fs");
const { ButtonStyle } = require("discord.js");
const { getUUID } = require("../../contracts/API/mowojangAPI.js");
const { upsertLink } = require("../../contracts/linkedStore.js");
const updateCommand = require("../commands/updateCommand.js");
const config = require("../../config");
const { actionButton, makePanel, panelPayload } = require("./componentsV2Panels.js");

const MANUAL_LINK_REQUEST_PATH = "data/manualLinkRequests.json";

class ManualLinkRequestService {
  constructor(discord) {
    this.discord = discord;
    this.state = {
      version: 1,
      requests: []
    };
  }

  ensureDataFile() {
    if (!existsSync(MANUAL_LINK_REQUEST_PATH)) {
      this.saveState({
        version: 1,
        requests: []
      });
    }
  }

  loadState() {
    this.ensureDataFile();
    try {
      const parsed = JSON.parse(readFileSync(MANUAL_LINK_REQUEST_PATH, "utf8"));
      this.state = {
        version: 1,
        requests: Array.isArray(parsed?.requests) ? parsed.requests : []
      };
    } catch {
      this.state = {
        version: 1,
        requests: []
      };
      this.saveState(this.state);
    }
  }

  saveState(nextState = this.state) {
    this.state = nextState;
    writeFileSync(MANUAL_LINK_REQUEST_PATH, JSON.stringify(this.state, null, 2));
  }

  initialize() {
    this.loadState();
    const now = Date.now();
    let changed = false;
    for (const request of this.state.requests) {
      if (request.status === "pending") {
        const createdTs = new Date(request.createdAt).getTime();
        if (Number.isFinite(createdTs) && now - createdTs > 7 * 24 * 60 * 60 * 1000) {
          request.status = "expired";
          request.reviewNote = request.reviewNote || "Expired after 7 days without review";
          changed = true;
        }
      }
    }
    if (changed) {
      this.saveState();
    }
  }

  makeRequestId() {
    return `ml-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getRequestById(requestId) {
    return this.state.requests.find((request) => request.requestId === requestId);
  }

  isStaffMember(member) {
    const commandRole = String(config.discord?.commands?.commandRole || "").trim();
    const allowedUsers = Array.isArray(config.discord?.commands?.users) ? config.discord.commands.users.map((id) => String(id)) : [];
    if (allowedUsers.includes(String(member?.user?.id || ""))) {
      return true;
    }
    if (!commandRole) {
      return false;
    }
    const memberRoles = member?.roles?.cache?.map((role) => role.id) ?? [];
    return memberRoles.includes(commandRole);
  }

  static isManualLinkComponent(customId) {
    return typeof customId === "string" && customId.startsWith("manual_link:");
  }

  static parseActionCustomId(customId) {
    const parts = String(customId || "").split(":");
    if (parts.length !== 3) {
      return null;
    }

    const [, action, requestId] = parts;
    if (!["approve", "deny"].includes(action)) {
      return null;
    }

    return { action, requestId };
  }

  buildReviewPayload(request) {
    const closed = ["approved", "denied", "expired"].includes(request.status);
    const panel = makePanel({
      title: "Manual Link Review",
      status: request.status.toUpperCase(),
      sections: [
        {
          title: "Claim",
          lines: [
            `Requested by: <@${request.requesterDiscordId}> (${request.requesterTag})`,
            `Claimed username: \`${request.claimedUsername}\``,
            `Created: <t:${Math.floor(new Date(request.createdAt).getTime() / 1000)}:f>`,
            `Reason: ${request.reason || "Hypixel API verification unavailable"}`
          ]
        },
        {
          title: "Review",
          lines: [
            request.reviewedByDiscordId ? `Reviewed by: <@${request.reviewedByDiscordId}>` : "Reviewed by: Pending",
            request.reviewedAt ? `Reviewed at: <t:${Math.floor(new Date(request.reviewedAt).getTime() / 1000)}:f>` : "Reviewed at: Pending",
            request.reviewNote ? `Note: ${request.reviewNote}` : "Note: N/A"
          ]
        }
      ],
      actions: [
        actionButton(`manual_link:approve:${request.requestId}`, "Approve", ButtonStyle.Success, { disabled: closed }),
        actionButton(`manual_link:deny:${request.requestId}`, "Deny", ButtonStyle.Danger, { disabled: closed })
      ],
      footer: `Request ID: ${request.requestId}`
    });

    return panelPayload(panel);
  }

  async createReviewRequest({ requesterDiscordId, requesterTag, claimedUsername, reason }) {
    const request = {
      requestId: this.makeRequestId(),
      requesterDiscordId,
      requesterTag,
      claimedUsername,
      reason: String(reason || "").slice(0, 300),
      status: "pending",
      createdAt: new Date().toISOString(),
      reviewedByDiscordId: null,
      reviewedAt: null,
      reviewNote: "",
      reviewMessageId: null,
      reviewChannelId: String(config.discord?.channels?.loggingChannel || "")
    };

    this.state.requests.push(request);
    this.saveState();

    const channelId = String(config.discord?.channels?.loggingChannel || "");
    const roleId = String(config.discord?.commands?.commandRole || "");
    const channel = channelId ? await this.discord.client.channels.fetch(channelId).catch(() => null) : null;

    if (!channel?.isTextBased?.()) {
      return request;
    }

    const mention = roleId ? `<@&${roleId}>` : "";
    const message = await channel
      .send({
        content: [mention, `Manual link review needed for **${request.claimedUsername}**`].filter(Boolean).join("\n"),
        ...this.buildReviewPayload(request)
      })
      .catch(() => null);

    if (message) {
      request.reviewMessageId = message.id;
      request.reviewChannelId = message.channelId;
      this.saveState();
    }

    return request;
  }

  async updateReviewMessage(request) {
    if (!request?.reviewMessageId || !request?.reviewChannelId) {
      return;
    }

    const channel = await this.discord.client.channels.fetch(request.reviewChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      return;
    }

    const message = await channel.messages.fetch(request.reviewMessageId).catch(() => null);
    if (!message) {
      return;
    }

    await message.edit(this.buildReviewPayload(request)).catch(() => {});
  }

  async handleComponent({ action, requestId, interaction }) {
    const request = this.getRequestById(requestId);
    if (!request) {
      return interaction.reply({ content: "Manual link request not found.", ephemeral: true });
    }

    if (!this.isStaffMember(interaction.member)) {
      return interaction.reply({ content: "You do not have permission to review manual link requests.", ephemeral: true });
    }

    if (request.status !== "pending") {
      return interaction.reply({ content: `Request already reviewed: ${request.status}.`, ephemeral: true });
    }

    if (action === "deny") {
      request.status = "denied";
      request.reviewedByDiscordId = interaction.user.id;
      request.reviewedAt = new Date().toISOString();
      request.reviewNote = "Denied by staff reviewer";
      this.saveState();
      await this.updateReviewMessage(request);
      await interaction.reply({ content: `Denied manual link request for \`${request.claimedUsername}\`.`, ephemeral: true });

      const user = await this.discord.client.users.fetch(request.requesterDiscordId).catch(() => null);
      if (user) {
        await user.send(`Your manual link request for \`${request.claimedUsername}\` was denied by staff.`).catch(() => {});
      }
      return;
    }

    const uuid = await getUUID(request.claimedUsername).catch(() => null);
    if (!uuid) {
      return interaction.reply({ content: `Could not resolve UUID for \`${request.claimedUsername}\`.`, ephemeral: true });
    }

    const linked = upsertLink(uuid, request.requesterDiscordId);
    if (!linked) {
      return interaction.reply({ content: "Could not save link (database unavailable).", ephemeral: true });
    }

    request.status = "approved";
    request.reviewedByDiscordId = interaction.user.id;
    request.reviewedAt = new Date().toISOString();
    request.reviewNote = `Approved by ${interaction.user.tag}`;
    this.saveState();
    await this.updateReviewMessage(request);

    await updateCommand
      .updateRoles({
        discordId: request.requesterDiscordId,
        uuid
      })
      .catch(() => {});

    await interaction.reply({ content: `Approved manual link for <@${request.requesterDiscordId}> -> \`${request.claimedUsername}\`.`, ephemeral: true });

    const user = await this.discord.client.users.fetch(request.requesterDiscordId).catch(() => null);
    if (user) {
      await user.send(`Your manual link request was approved. Linked to \`${request.claimedUsername}\`.`).catch(() => {});
    }
  }
}

module.exports = {
  ManualLinkRequestService
};
