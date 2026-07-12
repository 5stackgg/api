// SQL-suite config: same transform/mapping as the base package.json config,
// but scoped to test/ and wired to the shared-container global setup so the
// migration pipeline runs once and every suite clones the template database.
// Suites are independent (one clone each), so they run on jest's default
// parallel workers.
const base = require("../package.json").jest;

module.exports = {
  ...base,
  rootDir: "../src",
  roots: ["<rootDir>/../test"],
  globalSetup: "<rootDir>/../test/utils/jest-global-setup.ts",
  globalTeardown: "<rootDir>/../test/utils/jest-global-teardown.ts",
  testSequencer: "<rootDir>/../test/utils/slow-first-sequencer.js",
  // Every suite shares one container, so under CI's parallel workers a heavy
  // test (full tournament playouts, deep bracket resets) can run well past
  // jest's 5s default. Timing out mid-query is doubly bad here: jest abandons
  // the in-flight statement while it still holds row locks, so the next test's
  // beforeEach cleanup deadlocks against it. Give DB-bound tests real headroom.
  testTimeout: 60000,
};
