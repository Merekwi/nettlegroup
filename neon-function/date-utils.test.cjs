"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isoDate } = require("./date-utils.cjs");

test("PostgreSQL DATE objects are serialized as ISO calendar dates", () => {
  const pgDate = new Date("2026-02-01T00:00:00.000Z");
  assert.equal(isoDate(pgDate), "2026-02-01");
});

test("ISO date strings are retained without shifting calendar day", () => {
  assert.equal(isoDate("2026-02-01"), "2026-02-01");
  assert.equal(isoDate("2028-02-29"), "2028-02-29");
});

test("ambiguous weekday/month strings are rejected instead of losing the year", () => {
  assert.throws(() => isoDate("Sun Feb 01"), /ISO calendar date/);
});

test("invalid Date objects and impossible calendar dates are rejected", () => {
  assert.throws(() => isoDate(new Date("not a date")), /Invalid date/);
  assert.throws(() => isoDate("2026-02-30"), /Invalid ISO calendar date/);
});
