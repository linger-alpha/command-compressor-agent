"use strict";

const STRENGTH_PROFILES = {
  low: {
    name: "low",
    description: "Legacy compatibility label; block policy now determines compression per block.",
  },
  default: {
    name: "default",
    description: "Compatibility default; block policy now determines compression per block.",
  },
  high: {
    name: "high",
    description: "Legacy compatibility label; block policy now determines compression per block.",
  },
  xhigh: {
    name: "xhigh",
    description: "Legacy compatibility label; block policy now determines compression per block.",
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
