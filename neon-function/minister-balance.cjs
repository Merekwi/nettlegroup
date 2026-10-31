const SKILLS = Object.freeze({
  "Финансы": "finance",
  "Иностранные дела": "foreignAffairs",
  "Оборона": "defense",
  "Экономика": "economy",
  "Здравоохранение": "healthcare",
  "Образование": "education",
  "Внутренние дела": "internalAffairs"
});

const SKILL_LABELS = Object.freeze({
  finance: "Финансы",
  foreignAffairs: "Дипломатия",
  defense: "Оборона",
  economy: "Экономика",
  healthcare: "Здравоохранение",
  education: "Образование",
  internalAffairs: "Внутренние дела"
});

const ROLE_EFFECTS = Object.freeze({
  "Финансы": (skill) => ({
    inflation: -((skill - 50) * 0.002),
    budgetBalance: (skill - 50) * 0.0018
  }),
  "Иностранные дела": (skill) => ({
    gdpGrowth: (skill - 50) * 0.0012,
    stability: (skill - 50) * 0.0012
  }),
  "Оборона": (skill) => ({
    militaryPower: (skill - 50) * 0.0035,
    stability: (skill - 50) * 0.001
  }),
  "Экономика": (skill) => ({
    gdpGrowth: (skill - 50) * 0.002,
    unemployment: -((skill - 50) * 0.0015)
  }),
  "Здравоохранение": (skill) => ({
    healthcare: (skill - 50) * 0.0035,
    approval: (skill - 50) * 0.001
  }),
  "Образование": (skill) => ({
    education: (skill - 50) * 0.0035,
    gdpGrowth: (skill - 50) * 0.001
  }),
  "Внутренние дела": (skill) => ({
    stability: (skill - 50) * 0.002,
    corruption: -((skill - 50) * 0.0018)
  })
});

function roundEffects(effects) {
  return Object.fromEntries(
    Object.entries(effects).map(([key, value]) => [key, Number(value.toFixed(3))])
  );
}

/**
 * Build a candidate independently from any ministry. The president chooses
 * the candidate's mandate later; only that mandate's effects are active.
 */
function createMinisterProfile(randomInt) {
  if (typeof randomInt !== "function") {
    throw new TypeError("randomInt must be a function");
  }

  const skillKeys = Object.values(SKILLS);
  const skills = {};
  for (const key of skillKeys) {
    skills[key] = randomInt(35, 67);
  }

  const primaryIndex = randomInt(0, skillKeys.length);
  let secondaryIndex = randomInt(0, skillKeys.length - 1);
  if (secondaryIndex >= primaryIndex) secondaryIndex += 1;

  const primary = skillKeys[primaryIndex];
  const secondary = skillKeys[secondaryIndex];
  skills[primary] = randomInt(76, 93);
  skills[secondary] = randomInt(66, 87);

  const effectsByPortfolio = {};
  for (const [portfolio, skillKey] of Object.entries(SKILLS)) {
    effectsByPortfolio[portfolio] = roundEffects(ROLE_EFFECTS[portfolio](skills[skillKey]));
  }

  const competence = randomInt(45, 86);
  const loyalty = randomInt(42, 86);

  return {
    competence,
    loyalty,
    archetype: primary,
    traits: {
      archetype: primary,
      archetypeLabel: SKILL_LABELS[primary],
      skills,
      specializations: [primary, secondary],
      effectsByPortfolio
    }
  };
}

function calculateMonthlyTreasury(currentTreasury, monthlyBalance, eventTreasury, ministerBudgetEffect = 0) {
  const safe = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  const total = safe(currentTreasury) + safe(monthlyBalance) + safe(eventTreasury) + safe(ministerBudgetEffect) * 0.05;
  return Number(Math.max(0, total).toFixed(2));
}

module.exports = { createMinisterProfile, calculateMonthlyTreasury, SKILLS, SKILL_LABELS };
