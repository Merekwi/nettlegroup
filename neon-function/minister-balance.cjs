const PORTFOLIO_EFFECTS = Object.freeze({
  "Финансы": { inflation: -0.04, budgetBalance: 0.04 },
  "Иностранные дела": { gdpGrowth: 0.03, stability: 0.03 },
  "Оборона": { militaryPower: 0.16, stability: 0.08 },
  "Экономика": { gdpGrowth: 0.11, unemployment: -0.05 },
  "Здравоохранение": { healthcare: 0.18, approval: 0.08 },
  "Образование": { education: 0.16, gdpGrowth: 0.03 },
  "Внутренние дела": { stability: 0.10, corruption: -0.08 }
});

const ARCHETYPES = Object.freeze({
  technocrat: { label: "Технократ", effects: { gdpGrowth: 0.08, inflation: -0.025 } },
  reformer: { label: "Реформатор", effects: { publicServices: 0.13, approval: 0.11, stability: -0.03 } },
  diplomat: { label: "Дипломат", effects: { stability: 0.07, approval: 0.06 } },
  hardliner: { label: "Силовик", effects: { stability: 0.15, approval: -0.08, corruption: 0.04 } }
});

function createMinisterProfile(portfolio, randomInt) {
  if (!Object.prototype.hasOwnProperty.call(PORTFOLIO_EFFECTS, portfolio)) {
    throw new Error("Unknown minister portfolio");
  }
  if (typeof randomInt !== "function") throw new TypeError("randomInt must be a function");

  const competence = randomInt(48, 86);
  const loyalty = randomInt(45, 86);
  const archetypeKeys = Object.keys(ARCHETYPES);
  const archetype = archetypeKeys[randomInt(0, archetypeKeys.length)];
  const selected = ARCHETYPES[archetype];
  const effects = { ...PORTFOLIO_EFFECTS[portfolio] };
  for (const [key, value] of Object.entries(selected.effects)) {
    effects[key] = Number(((effects[key] || 0) + value).toFixed(3));
  }

  return {
    competence,
    loyalty,
    archetype,
    traits: { archetype, archetypeLabel: selected.label, effects }
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

module.exports = { createMinisterProfile, calculateMonthlyTreasury };
