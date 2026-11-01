const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TECHNOLOGIES, SERVICE_LAWS, initializeMilitaryState, normalizeMilitaryState,
  contractRecruitmentCapacity, legalMobilizationLimit, recruitByContract,
  mobilizeReserve, technologyProgress, calculateCombatPower, calculateDomainPower,
  estimateEnemyDomainPower, chooseAiPosture, calculateTheatrePower, resolveOperationalTurn
} = require("./war-engine.cjs");

test("military manpower starts from population and legal service model", () => {
  const military = initializeMilitaryState(20, 30000);
  assert.equal(military.manpower.eligiblePopulation, 4200000);
  assert.equal(military.manpower.activePersonnel, 30000);
  assert.equal(military.laws.service, "volunteer");
  assert.ok(military.manpower.availablePool >= 0);
});

test("contract enlistment depends on willingness, pay and monthly budget", () => {
  const base = initializeMilitaryState(15, 10000);
  const state = { population: 15, approval: 50, unemployment: 5 };
  const normal = contractRecruitmentCapacity(base, state);
  const higherPay = normalizeMilitaryState({ ...base, contracts: { salaryIndex: 2 } }, 15, 10000);
  assert.ok(contractRecruitmentCapacity(higherPay, state) > normal);

  const recruited = recruitByContract(base, state, 10000, 0.003);
  assert.ok(recruited.recruited >= 0);
  assert.ok(recruited.recruited <= recruited.applicants);
  assert.equal(recruited.military.manpower.activePersonnel, 10000 + recruited.recruited);

  const noBudget = recruitByContract(base, state, 10000, 0);
  assert.equal(noBudget.recruited, 0);
});

test("only laws that allow conscription can mobilize trained reserve", () => {
  const voluntary = initializeMilitaryState(10, 5000);
  assert.throws(() => mobilizeReserve(voluntary, 10000, 60), error => error.code === "draft_not_allowed");

  const selective = normalizeMilitaryState({ ...voluntary, laws: { service: "selective" } }, 10, 5000);
  const result = mobilizeReserve(selective, 100000, 60);
  assert.ok(result.mobilized > 0);
  assert.ok(result.mobilized <= Math.floor(2_100_000 * SERVICE_LAWS.selective.annualDraftShare));
  assert.equal(result.military.manpower.trainedReserve, selective.manpower.trainedReserve - result.mobilized);
});

test("research points complete exactly one technology level at a time", () => {
  const result = technologyProgress({ level: 1, research_points: 175 }, 40);
  assert.deepEqual(result, { level: 2, researchPoints: 15, completed: true, pointsToNext: 285 });
  assert.equal(TECHNOLOGIES.length, 9);
});

test("combat power uses personnel, readiness, supply and technology", () => {
  const unit = { active_personnel: 10000, equipment_level: 50, experience: 50, morale: 60, readiness: 70, supply: 80 };
  const base = calculateCombatPower([unit], []);
  const upgraded = calculateCombatPower([unit], [{ tech_id: "logistics", level: 5 }]);
  assert.ok(base > 0);
  assert.ok(upgraded > base);
  assert.equal(calculateCombatPower([], []), 0);
});

test("defensive posture protects friendly forces better than an offensive posture", () => {
  const war = { front_state: { territoryControl: 50, friendlyPersonnel: 60000, enemyPersonnel: 60000 } };
  const random = () => 0.5;
  const defensive = resolveOperationalTurn({ war, friendlyPower: 100000, enemyPower: 100000, posture: "defensive", random });
  const offensive = resolveOperationalTurn({ war, friendlyPower: 100000, enemyPower: 100000, posture: "offensive", random });
  assert.ok(defensive.control > 50);
  assert.ok(defensive.friendlyLosses < offensive.friendlyLosses);
  assert.ok(offensive.enemyLosses > defensive.enemyLosses);
});

test("presidential written directives guide AI posture, reconnaissance and logistics", () => {
  const war = { front_state: { territoryControl: 50, friendlyPersonnel: 60000, enemyPersonnel: 60000 } };
  const neutral = resolveOperationalTurn({ war, friendlyPower: 100000, enemyPower: 100000, random: () => 0.5 });
  const directed = resolveOperationalTurn({
    war, friendlyPower: 100000, enemyPower: 100000, posture: "balanced",
    directive: "Удерживать оборонительные рубежи, обеспечить снабжение и собрать разведданные.",
    random: () => 0.5
  });
  assert.equal(directed.appliedPosture, "defensive");
  assert.ok(directed.appliedDirective.includes("удерживать"));
  assert.ok(directed.control > neutral.control);
  assert.ok(directed.friendlyLosses < neutral.friendlyLosses);
});

test("operational turn updates territorial control and applies issued orders", () => {
  const war = { front_state: { territoryControl: 50, friendlyPersonnel: 50000, enemyPersonnel: 48000 } };
  const result = resolveOperationalTurn({
    war, friendlyPower: 120000, enemyPower: 95000, posture: "balanced",
    orders: [{ status: "queued", order_type: "advance" }],
    random: () => 0.5
  });
  assert.ok(result.control > 50);
  assert.ok(result.enemyLosses >= 0);
  assert.ok(["victory", "defeat", "initiative", "pressure", "stalemate"].includes(result.result));
});

test("land, aviation and naval forces contribute to separate combat domains", () => {
  const units = [
    { unit_branch: "land", active_personnel: 18000, quantity: 24, readiness: 70, supply: 80, equipment_level: 60, experience: 55, morale: 65 },
    { unit_branch: "air", active_personnel: 1200, quantity: 42, readiness: 75, supply: 85, equipment_level: 72, experience: 60, morale: 70 },
    { unit_branch: "naval", active_personnel: 900, quantity: 5, readiness: 65, supply: 75, equipment_level: 68, experience: 58, morale: 66 },
    { unit_branch: "guard", active_personnel: 2500, quantity: 10, readiness: 70, supply: 70, equipment_level: 45, experience: 50, morale: 65 }
  ];
  const domains = calculateDomainPower(units, [{ tech_id: "naval", level: 2 }]);
  assert.ok(domains.ground > 0);
  assert.ok(domains.air > 0);
  assert.ok(domains.naval > 0);
  assert.equal(domains.airframes, 42);
  assert.equal(domains.vessels, 5);
  assert.equal(domains.totalPersonnel, 22600);
  assert.equal(calculateCombatPower(units, [{ tech_id: "naval", level: 2 }]), domains.total);
});

test("AI headquarters changes posture using force balance, supply and presidential directives", () => {
  const weak = { ground: 30000, air: 2000, naval: 400, total: 32000 };
  const strongEnemy = { ground: 70000, air: 5000, naval: 1000, total: 73000 };
  assert.equal(chooseAiPosture({ friendlyDomains: weak, enemyDomains: strongEnemy, averageSupply: 72 }).posture, "defensive");
  const strong = { ground: 90000, air: 15000, naval: 1000, total: 97000 };
  const weakEnemy = { ground: 50000, air: 6000, naval: 600, total: 53000 };
  assert.equal(chooseAiPosture({ friendlyDomains: strong, enemyDomains: weakEnemy, averageSupply: 78 }).posture, "offensive");
  assert.equal(chooseAiPosture({ friendlyDomains: strong, enemyDomains: weakEnemy, averageSupply: 30 }).posture, "defensive");
  assert.equal(chooseAiPosture({ friendlyDomains: strong, enemyDomains: weakEnemy, averageSupply: 78, directive: "удерживать оборону" }).posture, "defensive");
});

test("air and naval superiority are reported separately by the operational model", () => {
  const result = resolveOperationalTurn({
    war: { front_state: { territoryControl: 50, friendlyPersonnel: 40000, enemyPersonnel: 42000 } },
    friendlyPower: 70000, enemyPower: 65000,
    friendlyDomains: { air: 18000, naval: 6000 },
    enemyDomains: { air: 5000, naval: 12000 },
    theatreType: "maritime",
    random: () => 0.5
  });
  assert.ok(result.domainControl.air > 50);
  assert.ok(result.domainControl.sea < 50);
  assert.ok(result.control > 50);
});

test("naval campaigns weight fleet and aviation higher than land manpower", () => {
  const seaForce = { ground: 12000, guard: 1000, air: 14000, naval: 65000 };
  assert.ok(calculateTheatrePower(seaForce, "maritime") > calculateTheatrePower(seaForce, "land"));
  const landForce = { ground: 65000, guard: 5000, air: 12000, naval: 400 };
  assert.ok(calculateTheatrePower(landForce, "land") > calculateTheatrePower(landForce, "maritime"));
});

test("operational cycles can record aircraft and ship attrition", () => {
  const result = resolveOperationalTurn({
    war: { front_state: { territoryControl: 50, friendlyPersonnel: 90000, enemyPersonnel: 85000 } },
    friendlyPower: 100000, enemyPower: 100000,
    friendlyDomains: { air: 18000, naval: 5000, airframes: 70, vessels: 8 },
    enemyDomains: { air: 9000, naval: 7000 },
    theatreType: "maritime", random: () => 0.5
  });
  assert.ok(Number.isInteger(result.friendlyAircraftLosses));
  assert.ok(Number.isInteger(result.friendlyVesselLosses));
  assert.ok(result.friendlyAircraftLosses <= 70);
  assert.ok(result.friendlyVesselLosses <= 8);
});
