const test = require("node:test");
const assert = require("node:assert/strict");
const { createMinisterProfile, calculateMonthlyTreasury, SKILLS } = require("./minister-balance.cjs");

function sequenceRandom() {
  let cursor = 0;
  return (min, max) => {
    const value = min + ((cursor++ * 7 + 3) % (max - min));
    assert.ok(value >= min && value < max);
    return value;
  };
}

test("minister candidates have varied, bounded skills and non-maxed general ratings", () => {
  const first = createMinisterProfile(sequenceRandom());
  const second = createMinisterProfile(sequenceRandom());

  assert.deepEqual(Object.keys(first.traits.skills).sort(), Object.values(SKILLS).sort());
  for (const profile of [first, second]) {
    assert.ok(profile.competence >= 45 && profile.competence <= 85);
    assert.ok(profile.loyalty >= 42 && profile.loyalty <= 85);
    assert.notEqual(profile.competence, 100);
    assert.notEqual(profile.loyalty, 100);
    for (const value of Object.values(profile.traits.skills)) {
      assert.ok(value >= 35 && value <= 92);
      assert.notEqual(value, 100);
    }
    assert.equal(profile.traits.specializations.length, 2);
    assert.notEqual(profile.traits.specializations[0], profile.traits.specializations[1]);
  }
  assert.notDeepEqual(first.traits.skills, second.traits.skills);
});

test("candidate profiles contain modest effects for every possible mandate", () => {
  const profile = createMinisterProfile(sequenceRandom());
  assert.deepEqual(Object.keys(profile.traits.effectsByPortfolio).sort(), Object.keys(SKILLS).sort());

  for (const effects of Object.values(profile.traits.effectsByPortfolio)) {
    assert.ok(Object.keys(effects).length > 0);
    for (const value of Object.values(effects)) {
      assert.ok(Math.abs(value) <= 0.16, `Effect ${value} is too large`);
    }
  }
});

test("only the selected mandate's skill determines its sector effects", () => {
  const profile = createMinisterProfile(sequenceRandom());
  const health = profile.traits.effectsByPortfolio["Здравоохранение"];
  const defense = profile.traits.effectsByPortfolio["Оборона"];

  assert.ok(Object.hasOwn(health, "healthcare"));
  assert.ok(!Object.hasOwn(health, "militaryPower"));
  assert.ok(Object.hasOwn(defense, "militaryPower"));
  assert.ok(!Object.hasOwn(defense, "healthcare"));
});

test("monthly treasury calculation treats a missing minister budget effect as zero", () => {
  assert.equal(calculateMonthlyTreasury(89.5, 29.71, 0, undefined), 119.21);
  assert.equal(calculateMonthlyTreasury(null, 29.71, -0.1, NaN), 29.61);
});
