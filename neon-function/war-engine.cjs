const TECHNOLOGIES = Object.freeze([
  { id: "reconnaissance", label: "Разведка и наблюдение", baseCost: 100, bonus: "Точность разведданных и раннее обнаружение угроз" },
  { id: "communications", label: "Связь и командование", baseCost: 110, bonus: "Согласованность действий и скорость приказов" },
  { id: "logistics", label: "Военная логистика", baseCost: 120, bonus: "Снабжение, ремонт и устойчивость частей" },
  { id: "air_defense", label: "Противовоздушная оборона", baseCost: 140, bonus: "Защита объектов и войск от воздушных угроз" },
  { id: "armor", label: "Бронетехника", baseCost: 150, bonus: "Защищённость и мобильность сухопутных частей" },
  { id: "precision", label: "Точность вооружений", baseCost: 180, bonus: "Снижение потерь и повышение эффективности операций" },
  { id: "military_medicine", label: "Военная медицина", baseCost: 100, bonus: "Сокращение безвозвратных потерь и ускорение восстановления" },
  { id: "naval", label: "Морские системы", baseCost: 135, bonus: "Готовность флота и защита морских коммуникаций" },
  { id: "cyber_defense", label: "Киберзащита", baseCost: 160, bonus: "Устойчивость инфраструктуры и военных сетей" }
]);

const SERVICE_LAWS = Object.freeze({
  volunteer: { label: "Добровольная служба", annualDraftShare: 0, legalReserveShare: 0.04, politicalCost: 0 },
  selective: { label: "Выборочный призыв", annualDraftShare: 0.025, legalReserveShare: 0.11, politicalCost: 0.12 },
  universal: { label: "Всеобщая воинская обязанность", annualDraftShare: 0.07, legalReserveShare: 0.22, politicalCost: 0.32 }
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : min));
const round = value => Number(Number(value || 0).toFixed(2));

function initializeMilitaryState(populationMillions, activePersonnel = 0) {
  const population = Math.max(0.1, Number(populationMillions) || 1) * 1_000_000;
  const eligible = Math.floor(population * 0.21);
  const active = Math.max(0, Math.floor(Number(activePersonnel) || 0));
  return {
    version: 1,
    laws: { service: "volunteer", contractService: true, minimumContractMonths: 12 },
    manpower: {
      eligiblePopulation: eligible,
      activePersonnel: active,
      trainedReserve: Math.floor(eligible * 0.025),
      availablePool: Math.max(0, Math.floor(eligible * 0.04) - active),
      mobilizedPersonnel: 0
    },
    contracts: { salaryIndex: 1, monthlyApplicants: 0, recruitedThisMonth: 0, enlistmentSupport: 50 },
    budget: { shareOfGdp: 1.6, researchShare: 0.12 },
    research: { selectedTech: "logistics", monthlyPoints: 0 },
    programs: [],
    lastMonth: {}
  };
}

function normalizeMilitaryState(input, populationMillions, activePersonnel = 0) {
  const base = initializeMilitaryState(populationMillions, activePersonnel);
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const laws = source.laws && typeof source.laws === "object" ? source.laws : {};
  const manpower = source.manpower && typeof source.manpower === "object" ? source.manpower : {};
  const contracts = source.contracts && typeof source.contracts === "object" ? source.contracts : {};
  const budget = source.budget && typeof source.budget === "object" ? source.budget : {};
  const research = source.research && typeof source.research === "object" ? source.research : {};
  return {
    ...base,
    ...source,
    laws: {
      ...base.laws, ...laws,
      service: Object.hasOwn(SERVICE_LAWS, laws.service) ? laws.service : base.laws.service
    },
    manpower: { ...base.manpower, ...manpower },
    contracts: { ...base.contracts, ...contracts, salaryIndex: clamp(contracts.salaryIndex ?? 1, 0.65, 2.2) },
    budget: { ...base.budget, ...budget, shareOfGdp: clamp(budget.shareOfGdp ?? 1.6, 0.5, 6), researchShare: clamp(budget.researchShare ?? 0.12, 0.02, 0.4) },
    research: { ...base.research, ...research },
    programs: Array.isArray(source.programs) ? source.programs : [],
    lastMonth: source.lastMonth && typeof source.lastMonth === "object" ? source.lastMonth : {}
  };
}

function contractRecruitmentCapacity(military, state) {
  const m = normalizeMilitaryState(military, state.population || 1, military?.manpower?.activePersonnel || 0);
  const eligible = Math.max(0, Number(m.manpower.eligiblePopulation || 0));
  const wage = clamp(m.contracts.salaryIndex, 0.65, 2.2);
  const approval = clamp(state.approval ?? 50, 0, 100);
  const unemployment = clamp(state.unemployment ?? 5, 0, 60);
  const serviceAppeal = clamp((approval * 0.45 + (100 - unemployment) * 0.25 + 50 * 0.3) / 100, 0.45, 1.05);
  const wageFactor = clamp(0.55 + wage * 0.5, 0.85, 1.65);
  // Applicants are only people willing to sign a contract; this is not automatic conscription.
  return Math.floor(eligible * 0.000075 * serviceAppeal * wageFactor);
}

function legalMobilizationLimit(military) {
  const law = SERVICE_LAWS[military?.laws?.service] || SERVICE_LAWS.volunteer;
  const eligible = Math.max(0, Number(military?.manpower?.eligiblePopulation || 0));
  return Math.floor(eligible * law.legalReserveShare);
}

function recruitByContract(military, state, activePersonnel, monthlyBudgetBillions) {
  const m = normalizeMilitaryState(military, state.population || 1, activePersonnel);
  const applicants = contractRecruitmentCapacity(m, state);
  const legalLimit = legalMobilizationLimit(m);
  const gap = Math.max(0, legalLimit - Number(activePersonnel || 0));
  const monthlyPayPerRecruit = 0.0000018 * clamp(m.contracts.salaryIndex, 0.65, 2.2);
  const affordable = monthlyPayPerRecruit > 0
    ? Math.floor(Math.max(0, monthlyBudgetBillions) / monthlyPayPerRecruit)
    : 0;
  const recruited = Math.max(0, Math.min(applicants, gap, affordable, 4500));
  m.contracts.monthlyApplicants = applicants;
  m.contracts.recruitedThisMonth = recruited;
  m.manpower.activePersonnel = Number(activePersonnel || 0) + recruited;
  m.manpower.availablePool = Math.max(0, legalLimit - m.manpower.activePersonnel);
  return { military: m, recruited, applicants, legalLimit, annualDraftShare: 0 };
}

function mobilizeReserve(military, requested, approval) {
  const m = structuredClone(military);
  const law = SERVICE_LAWS[m.laws?.service] || SERVICE_LAWS.volunteer;
  if (law.annualDraftShare <= 0) throw Object.assign(new Error("Текущий закон не предусматривает призыв резервистов"), { code: "draft_not_allowed" });
  const eligible = Number(m.manpower?.eligiblePopulation || 0);
  const already = Number(m.manpower?.mobilizedPersonnel || 0);
  const annualLegalCap = Math.floor(eligible * law.annualDraftShare);
  const available = Math.max(0, Math.min(Number(m.manpower?.trainedReserve || 0), annualLegalCap - already));
  const politicalFactor = clamp(0.55 + Number(approval || 50) / 220, 0.45, 1);
  const mobilized = Math.floor(Math.min(Math.max(0, Number(requested) || 0), available) * politicalFactor);
  m.manpower.mobilizedPersonnel = already + mobilized;
  m.manpower.activePersonnel = Number(m.manpower.activePersonnel || 0) + mobilized;
  m.manpower.trainedReserve = Math.max(0, Number(m.manpower.trainedReserve || 0) - mobilized);
  return { military: m, mobilized, legalRemaining: Math.max(0, annualLegalCap - m.manpower.mobilizedPersonnel) };
}

function technologyProgress(tech, monthlyResearchPoints) {
  const level = clamp(tech?.level || 0, 0, 5);
  const points = Math.max(0, Number(tech?.research_points || 0)) + Math.max(0, Number(monthlyResearchPoints || 0));
  const target = (level + 1) * 100;
  if (level >= 5 || points < target) {
    return { level, researchPoints: Math.floor(points), completed: false, pointsToNext: Math.max(0, target - points) };
  }
  return { level: level + 1, researchPoints: Math.floor(points - target), completed: true, pointsToNext: (level + 2) * 100 - Math.floor(points - target) };
}

function calculateCombatPower(units, technologies = []) {
  const techLevels = Object.fromEntries((technologies || []).map(row => [row.tech_id, Number(row.level || 0)]));
  const techFactor = 1 + Object.values(techLevels).reduce((sum, level) => sum + clamp(level, 0, 5), 0) * 0.012;
  return (units || []).reduce((total, unit) => {
    const personnel = Math.max(0, Number(unit.active_personnel || 0));
    const quality = 0.55 + clamp(unit.equipment_level || 35, 0, 100) / 220 +
      clamp(unit.experience || 35, 0, 100) / 260 +
      clamp(unit.morale || 60, 0, 100) / 400 +
      clamp(unit.readiness || 50, 0, 100) / 400;
    const supply = 0.45 + clamp(unit.supply || 50, 0, 100) / 180;
    return total + personnel * quality * supply * techFactor;
  }, 0);
}

function resolveOperationalTurn({ war, friendlyPower, enemyPower, posture = "balanced", orders = [], random = Math.random }) {
  const attackFactor = posture === "offensive" ? 1.12 : posture === "defensive" ? 0.94 : 1;
  // Defensive posture improves friendly force protection and reduces enemy pressure.
  const defenseFactor = posture === "defensive" ? 0.88 : posture === "offensive" ? 1.08 : 1;
  const orderFactor = (orders || []).reduce((sum, item) => {
    if (item.status !== "queued") return sum;
    return sum + (item.order_type === "advance" ? 0.025 : item.order_type === "defend" ? 0.02 : item.order_type === "recon" ? 0.01 : 0);
  }, 0);
  const friendly = Math.max(1, Number(friendlyPower || 1) * attackFactor * (1 + Math.min(0.1, orderFactor)) * (0.94 + random() * 0.12));
  const enemy = Math.max(1, Number(enemyPower || 1) * defenseFactor * (0.94 + random() * 0.12));
  const balance = friendly / (friendly + enemy);
  const control = clamp(Number(war?.front_state?.territoryControl ?? 50) + (balance - 0.5) * 12, 0, 100);
  const friendlyLosses = Math.max(0, Math.round(Math.min(0.006, 0.0015 + (enemy / friendly) * 0.001) * Number(war?.front_state?.friendlyPersonnel || 0)));
  const enemyLosses = Math.max(0, Math.round(Math.min(0.007, 0.0015 + (friendly / enemy) * 0.0012) * Number(war?.front_state?.enemyPersonnel || 0)));
  const result = control >= 95 ? "victory" : control <= 5 ? "defeat" : balance > 0.56 ? "initiative" : balance < 0.44 ? "pressure" : "stalemate";
  return {
    control: Number(control.toFixed(1)),
    friendlyLosses,
    enemyLosses,
    result,
    friendlyPower: Math.round(friendly),
    enemyPower: Math.round(enemy)
  };
}

module.exports = {
  TECHNOLOGIES,
  SERVICE_LAWS,
  initializeMilitaryState,
  normalizeMilitaryState,
  contractRecruitmentCapacity,
  legalMobilizationLimit,
  recruitByContract,
  mobilizeReserve,
  technologyProgress,
  calculateCombatPower,
  resolveOperationalTurn
};
