const test = require("node:test");
const assert = require("node:assert/strict");
const { createMinisterProfile } = require("./minister-balance.cjs");

function sequenceRandom(values) {
  const queue = [...values];
  return (min, max) => {
    const value = queue.shift();
    assert.notEqual(value, undefined, "Unexpected random call");
    assert.ok(value >= min && value < max, `Expected ${value} in [${min}, ${max})`);
    return value;
  };
}

test("new ministers receive varied, non-maxed arcade ratings", () => {
  const first = createMinisterProfile("Финансы", sequenceRandom([48, 45, 0]));
  const second = createMinisterProfile("Оборона", sequenceRandom([85, 85, 3]));

  assert.deepEqual([first.competence, first.loyalty], [48, 45]);
  assert.deepEqual([second.competence, second.loyalty], [85, 85]);
  for (const profile of [first, second]) {
    assert.ok(profile.competence >= 48 && profile.competence <= 85);
    assert.ok(profile.loyalty >= 45 && profile.loyalty <= 85);
    assert.notEqual(profile.competence, 100);
    assert.notEqual(profile.loyalty, 100);
  }
  assert.notEqual(first.archetype, second.archetype);
});

test("minister specializations keep portfolio effects small and readable", () => {
  const profile = createMinisterProfile("Здравоохранение", sequenceRandom([70, 65, 1]));
  assert.equal(profile.traits.archetypeLabel, "Реформатор");
  assert.ok(Object.keys(profile.traits.effects).length <= 5);
  for (const value of Object.values(profile.traits.effects)) {
    assert.ok(Math.abs(value) <= 0.25, `Effect ${value} is too large`);
  }
});

test("unknown minister portfolios are rejected", () => {
  assert.throws(() => createMinisterProfile("Несуществующее министерство", () => 0), /Unknown minister portfolio/);
});
