const { getUuidByDiscordId } = require("./linkedStore.js");
const config = require('../config');

function isGuildMember(interaction) {
  const user = interaction.member;
  const userRoles = user.roles.cache.map((role) => role.id);

  if (
    config.discord.commands.checkPerms === true &&
    !(userRoles.includes(config.verification.roles.guildMember.roleId) || config.discord.commands.users.includes(user.id))
  ) {
    return false;
  }

  return true;
}

function isVerifiedMember(interaction) {
  const user = interaction.member;
  const userRoles = user.roles.cache.map((role) => role.id);

  if (
    config.discord.commands.checkPerms === true &&
    !(userRoles.includes(config.verification.roles.verified.roleId) || config.discord.commands.users.includes(user.id))
  ) {
    return false;
  }

  return true;
}

function isLinkedMember(interaction) {
  const uuid = getUuidByDiscordId(interaction.user.id);
  if (!uuid) {
    return false;
  }

  return true;
}

module.exports = {
  isGuildMember,
  isVerifiedMember,
  isLinkedMember
};
