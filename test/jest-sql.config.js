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
};
