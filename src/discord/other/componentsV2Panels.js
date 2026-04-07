const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder
} = require("discord.js");

function chunkTextDisplays(lines, size = 3) {
  const out = [];
  for (let i = 0; i < lines.length; i += size) {
    out.push(lines.slice(i, i + size));
  }
  return out;
}

function makeText(content) {
  return new TextDisplayBuilder().setContent(String(content || ""));
}

function makeSection(title, lines = []) {
  const content = [`### ${title}`, ...lines].join("\n");
  return makeText(content);
}

function makePanel({
  title,
  status = null,
  sections = [],
  topRows = [],
  actions = [],
  tabs = [],
  nav = [],
  extraRows = [],
  accentColor = 0x5865f2,
  footer = null
}) {
  const container = new ContainerBuilder().setAccentColor(accentColor);
  const headerLines = [`## ${title}`];
  if (status) headerLines.push(`**Status:** ${status}`);
  container.addTextDisplayComponents(makeText(headerLines.join("\n")));

  if (Array.isArray(topRows) && topRows.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    for (const row of topRows) {
      if (row) container.addActionRowComponents(row);
    }
  }

  for (const section of sections) {
    container.addTextDisplayComponents(makeSection(section.title, section.lines || []));
  }

  if (actions.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    for (const group of chunkTextDisplays(actions, 5)) {
      const row = new ActionRowBuilder().addComponents(...group);
      container.addActionRowComponents(row);
    }
  }

  if (tabs.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    for (const group of chunkTextDisplays(tabs, 5)) {
      container.addActionRowComponents(new ActionRowBuilder().addComponents(...group));
    }
  }

  if (nav.length > 0) {
    for (const group of chunkTextDisplays(nav, 5)) {
      container.addActionRowComponents(new ActionRowBuilder().addComponents(...group));
    }
  }

  if (Array.isArray(extraRows) && extraRows.length > 0) {
    for (const row of extraRows) {
      if (row) container.addActionRowComponents(row);
    }
  }

  if (footer) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(makeText(footer));
  }

  return container;
}

function panelPayload(panel, { ephemeral = false } = {}) {
  const flags = ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2;
  return {
    flags,
    components: [panel]
  };
}

function infoPayload({ title, lines = [], status = null, accentColor = 0x5865f2, actions = [], ephemeral = false }) {
  const panel = makePanel({
    title,
    status,
    sections: [{ title: "Details", lines }],
    actions,
    accentColor
  });
  return panelPayload(panel, { ephemeral });
}

function actionButton(customId, label, style = ButtonStyle.Secondary, options = {}) {
  const btn = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (options.emoji) btn.setEmoji(options.emoji);
  if (options.disabled) btn.setDisabled(true);
  return btn;
}

module.exports = {
  actionButton,
  infoPayload,
  makePanel,
  panelPayload
};
