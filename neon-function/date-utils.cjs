"use strict";

function isoDate(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("Invalid date value returned by PostgreSQL");
    }
    return value.toISOString().slice(0, 10);
  }

  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError("Expected an ISO calendar date (YYYY-MM-DD)");
  }

  const parsed = new Date(text + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new TypeError("Invalid ISO calendar date: " + text);
  }
  return text;
}

module.exports = { isoDate };
