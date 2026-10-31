const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TECHNOLOGIES, SERVICE_LAWS, initializeMilitaryState, normalizeMilitaryState,
  contractRecruitmentCapacity, legalMobilizationLimit, recruitByContract,
  mobilizeReserve, technologyProgress, calculateCombatPower, resolveOperationalTurn
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
