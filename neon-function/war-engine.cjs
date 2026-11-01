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
    laws: { ...base.laws, ...laws, service: Object.hasOwn(SERVICE_LAWS, laws.service) ? laws.service : base.laws.service },
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
  const affordable = monthlyPayPerRecruit > 0 ? Math.floor(Math.max(0, monthlyBudgetBillions) / monthlyPayPerRecruit) : 0;
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
  if (level >= 5 || points < target) return { level, researchPoints: Math.floor(points), completed: false, pointsToNext: Math.max(0, target - points) };
  return { level: level + 1, researchPoints: Math.floor(points - target), completed: true, pointsToNext: (level + 2) * 100 - Math.floor(points - target) };
}

function unitQuality(unit) {
  return 0.55 + clamp(unit.equipment_level ?? 35, 0, 100) / 220 +
    clamp(unit.experience ?? 35, 0, 100) / 260 +
    clamp(unit.morale ?? 60, 0, 100) / 400 +
    clamp(unit.readiness ?? 50, 0, 100) / 400;
}

function calculateDomainPower(units, technologies = []) {
  const tech = Object.fromEntries((technologies || []).map(row => [row.tech_id, Number(row.level || 0)]));
  const levels = key => clamp(tech[key] || 0, 0, 5);
  const result = { ground: 0, air: 0, naval: 0, guard: 0, totalPersonnel: 0, airframes: 0, vessels: 0 };
  for (const unit of units || []) {
    const branch = String(unit.unit_branch || "land").toLowerCase();
    const quality = unitQuality(unit);
    const supply = 0.45 + clamp(unit.supply ?? 50, 0, 100) / 180;
    const readiness = 0.55 + clamp(unit.readiness ?? 50, 0, 100) / 220;
    const personnel = Math.max(0, Number(unit.active_personnel || 0));
    const quantity = Math.max(0, Number(unit.quantity || 0));
    result.totalPersonnel += personnel;
    if (branch === "land") {
      result.ground += personnel * quality * supply * (1 + levels("armor") * 0.035);
    } else if (branch === "guard") {
      result.guard += personnel * quality * supply * 0.28;
    } else if (branch === "air") {
      result.airframes += quantity;
      result.air += quantity * 72 * quality * readiness * supply * (1 + levels("precision") * 0.025);
    } else if (branch === "naval") {
      result.vessels += quantity;
      result.naval += quantity * 245 * quality * readiness * supply * (1 + levels("naval") * 0.04);
    }
  }
  const comms = 1 + levels("communications") * 0.012;
  result.ground *= comms;
  result.air *= comms;
  result.naval *= comms;
  result.total = result.ground + result.guard + result.air * 0.42 + result.naval * 0.12;
  for (const key of ["ground", "guard", "air", "naval", "total"]) result[key] = Math.round(result[key]);
  result.totalPersonnel = Math.round(result.totalPersonnel);
  result.airframes = Math.round(result.airframes);
  result.vessels = Math.round(result.vessels);
  return result;
}

function estimateEnemyDomainPower(enemyPersonnel, militaryPower = 45) {
  const personnel = Math.max(0, Number(enemyPersonnel || 0));
  const quality = clamp(Number(militaryPower || 45), 5, 100);
  const factor = 0.62 + quality / 210;
  const ground = personnel * 0.76 * factor;
  const air = personnel * 0.00019 * (0.65 + quality / 100) * 72;
  const naval = personnel * 0.000028 * (0.65 + quality / 100) * 245;
  return {
    ground: Math.round(ground), guard: Math.round(personnel * 0.08 * factor),
    air: Math.round(air), naval: Math.round(naval),
    total: Math.round(ground + personnel * 0.08 * factor + air * 0.42 + naval * 0.12),
    totalPersonnel: Math.round(personnel), estimated: true
  };
}

function chooseAiPosture({ friendlyDomains, enemyDomains, averageSupply = 70, currentPosture = "balanced", directive = "" }) {
  const text = String(directive || "").toLocaleLowerCase("ru-RU");
  if (/(удерж|оборону|оборонять|не наступ|сохранить рубеж|минимизировать потери)/.test(text)) return { posture: "defensive", reason: "Исполнение президентской директивы: удержание позиций" };
  if (/(наступ|атак|продвинуться|занять район|захватить позици)/.test(text)) return { posture: "offensive", reason: "Исполнение президентской директивы: наступательные действия" };
  if (currentPosture !== "balanced") return { posture: currentPosture, reason: currentPosture === "defensive" ? "Установлена президентом оборонительная стратегия" : "Установлена президентом наступательная стратегия" };
  const own = Number(friendlyDomains?.total || 0);
  const rival = Math.max(1, Number(enemyDomains?.total || 1));
  const ratio = own / rival;
  if (averageSupply < 43) return { posture: "defensive", reason: "Недостаточный уровень снабжения: штаб сохраняет силы" };
  if (ratio < 0.84) return { posture: "defensive", reason: "Соотношение сил не позволяет безопасно наступать" };
  if (ratio > 1.18 && Number(friendlyDomains?.air || 0) >= Number(enemyDomains?.air || 0) * 0.82) return { posture: "offensive", reason: "Преимущество в силах и приемлемая воздушная поддержка" };
  return { posture: "balanced", reason: "Силы сопоставимы: штаб избегает неоправданного риска" };
}

function calculateTheatrePower(domains, theatreType = "land") {
  if (!domains) return 0;
  const value = theatreType === "maritime"
    ? Number(domains.naval || 0) + Number(domains.air || 0) * 0.68 + Number(domains.ground || 0) * 0.13 + Number(domains.guard || 0) * 0.03
    : Number(domains.ground || 0) + Number(domains.guard || 0) + Number(domains.air || 0) * 0.46 + Number(domains.naval || 0) * 0.035;
  return Math.max(0, Math.round(value));
}

function calculateCombatPower(units, technologies = []) {
  return calculateDomainPower(units, technologies).total;
}

function resolveOperationalTurn({
  war, friendlyPower, enemyPower, posture = "balanced", orders = [], directive = "",
  friendlyDomains = null, enemyDomains = null, theatreType = "land", intensity = 1, random = Math.random
}) {
  const text = String(directive || "").toLocaleLowerCase("ru-RU");
  const asksToDefend = /(удерж|оборону|оборонять|не наступ|сохранить рубеж|минимизировать потери)/.test(text);
  const asksToAdvance = /(наступ|атак|продвинуться|занять район|захватить позици)/.test(text);
  const asksRecon = /(развед|наблюден|разведданн)/.test(text);
  const asksLogistics = /(снабжен|логист|ремонт|перегрупп|резерв)/.test(text);
  const chosenPosture = asksToDefend ? "defensive" : asksToAdvance ? "offensive" : posture;
  const airOwn = Number(friendlyDomains?.air || 0);
  const airEnemy = Number(enemyDomains?.air || 0);
  const seaOwn = Number(friendlyDomains?.naval || 0);
  const seaEnemy = Number(enemyDomains?.naval || 0);
  const airControl = airOwn + airEnemy > 0 ? airOwn / (airOwn + airEnemy) : 0.5;
  const seaControl = seaOwn + seaEnemy > 0 ? seaOwn / (seaOwn + seaEnemy) : 0.5;
  const airSupport = 1 + (airControl - 0.5) * 0.28;
  const theatreSupport = theatreType === "maritime" ? 1 + (seaControl - 0.5) * 0.32 : 1 + (seaControl - 0.5) * 0.04;
  const attackFactor = chosenPosture === "offensive" ? 1.10 : chosenPosture === "defensive" ? 0.97 : 1;
  const defenseFactor = chosenPosture === "defensive" ? 0.90 : chosenPosture === "offensive" ? 1.06 : 1;
  const orderFactor = (orders || []).reduce((sum, item) => {
    if (item.status !== "queued") return sum;
    return sum + (item.order_type === "advance" ? 0.02 : item.order_type === "defend" ? 0.018 : item.order_type === "recon" ? 0.009 : 0);
  }, 0);
  const directiveFactor = (asksRecon ? 0.008 : 0) + (asksLogistics ? 0.012 : 0);
  const noise = 0.975 + random() * 0.05;
  const friendly = Math.max(1, Number(friendlyPower || 1) * attackFactor * airSupport * theatreSupport *
    (1 + Math.min(0.08, orderFactor + directiveFactor)) * noise);
  const enemy = Math.max(1, Number(enemyPower || 1) * defenseFactor *
    (1 + (0.5 - airControl) * 0.12) *
    (theatreType === "maritime" ? 1 + (0.5 - seaControl) * 0.16 : 1) *
    (asksRecon ? 0.992 : 1) * (asksLogistics ? 0.994 : 1) * (0.975 + random() * 0.05));
  const balance = friendly / (friendly + enemy);
  const controlDelta = (balance - 0.5) * (theatreType === "maritime" ? 5.5 : 7.2);
  const control = clamp(Number(war?.front_state?.territoryControl ?? 50) + controlDelta, 0, 100);
  const routineIntensity = clamp(intensity, 0.25, 1.5);
  const friendlyLossPosture = chosenPosture === "defensive" ? 0.78 : chosenPosture === "offensive" ? 1.13 : 1;
  const enemyLossPosture = chosenPosture === "offensive" ? 1.16 : chosenPosture === "defensive" ? 0.92 : 1;
  const friendlyLosses = Math.max(0, Math.round(Math.min(0.00072, (0.00012 + (enemy / friendly) * 0.00013) * routineIntensity * friendlyLossPosture) * Number(war?.front_state?.friendlyPersonnel || 0)));
  const enemyLosses = Math.max(0, Math.round(Math.min(0.00086, (0.00012 + (friendly / enemy) * 0.00015) * routineIntensity * enemyLossPosture) * Number(war?.front_state?.enemyPersonnel || 0)));
  const result = control >= 95 ? "victory" : control <= 5 ? "defeat" : balance > 0.56 ? "initiative" : balance < 0.44 ? "pressure" : "stalemate";
  return {
    control: Number(control.toFixed(1)), controlDelta: Number(controlDelta.toFixed(2)),
    friendlyLosses, enemyLosses, result,
    friendlyPower: Math.round(friendly), enemyPower: Math.round(enemy),
    domainControl: { air: Number((airControl * 100).toFixed(1)), sea: Number((seaControl * 100).toFixed(1)) },
    appliedDirective: text.slice(0, 240), appliedPosture: chosenPosture
  };
}

module.exports = {
  TECHNOLOGIES, SERVICE_LAWS, initializeMilitaryState, normalizeMilitaryState,
  contractRecruitmentCapacity, legalMobilizationLimit, recruitByContract,
  mobilizeReserve, technologyProgress, calculateCombatPower, calculateDomainPower,
  estimateEnemyDomainPower, chooseAiPosture, calculateTheatrePower, resolveOperationalTurn
};
