"use strict";

const STRENGTH_PROFILES = {
  low: {
    name: "low",
    minRawTokens: 2000,
    strongOnly: true,
    description: "Only compress outputs above 2k estimated tokens, and only with strong loss-resistant rules.",
  },
  default: {
    name: "default",
    minRawTokens: 2000,
    strongOnly: false,
    description: "Exempt outputs below 2k estimated tokens. This is the recommended release setting.",
  },
  high: {
    name: "high",
    minRawTokens: 1000,
    strongOnly: false,
    description: "Exempt outputs below 1k estimated tokens.",
  },
  xhigh: {
    name: "xhigh",
    minRawTokens: 0,
    strongOnly: false,
    description: "No length exemption. Experimental and not recommended for score-sensitive work.",
  },
};

function normalizeStrength(value) {
  const name = String(value || "default").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STRENGTH_PROFILES, name)) return name;
  return "default";
}

function resolveStrengthProfile(value) {
  return STRENGTH_PROFILES[normalizeStrength(value)];
}

function listStrengthProfiles() {
  return Object.values(STRENGTH_PROFILES);
}

module.exports = {
  STRENGTH_PROFILES,
  listStrengthProfiles,
  normalizeStrength,
  resolveStrengthProfile,
};
