const Sequencer = require("@jest/test-sequencer").default;

// Jest's default sequencer only knows suite durations after a cached run, and
// CI runs cold — so the slowest suites otherwise start last and tail the whole
// run. Pin the known-heavy suites to the front; everything else keeps jest's
// default order behind them.
const SLOW_FIRST = [
  "fixtures-warm-reapply.spec.ts",
  "fixtures.spec.ts",
  "tournament-stages.spec.ts",
  "tournament-reset.spec.ts",
  "tournament-edge-cases.spec.ts",
  "tournaments.spec.ts",
];

class SlowFirstSequencer extends Sequencer {
  sort(tests) {
    const rank = (test) => {
      const index = SLOW_FIRST.findIndex((name) => test.path.endsWith(name));
      return index === -1 ? SLOW_FIRST.length : index;
    };
    return super.sort(tests).sort((a, b) => rank(a) - rank(b));
  }
}

module.exports = SlowFirstSequencer;
