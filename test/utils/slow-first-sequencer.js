const { basename } = require("path");
const Sequencer = require("@jest/test-sequencer").default;

// Rough seconds per suite on a CI runner, for the suites heavy enough to matter.
// Jest's default sequencer only knows suite durations after a cached run, and
// CI runs cold, so the slowest suites would otherwise start last and tail the
// whole run. Jest's own --shard splits by path hash, which can stack several of
// them on one runner. Anything unlisted takes a couple of seconds.
const WEIGHTS = {
  "tournament-stages.spec.ts": 24,
  "fixtures.spec.ts": 23,
  "tournament-free-agent-flow.spec.ts": 18,
  "awards.spec.ts": 17,
  "tournament-group-stages.spec.ts": 16,
  "tournament-roster-lineup-refresh.spec.ts": 15,
  "map-veto.spec.ts": 15,
  "hasura-socket-sessions.spec.ts": 15,
  "tournament-reset.spec.ts": 11,
  "tournament-bracket-match-recreate.spec.ts": 10,
  "fixtures-warm-reapply.spec.ts": 10,
  "chat-redis-actions.spec.ts": 10,
  "tournament-stage-edits.spec.ts": 7,
  "match-chat-archive.spec.ts": 7,
  "tournament-check-in-and-free-agents.spec.ts": 6,
  "utility-practice.spec.ts": 6,
  "tournaments.spec.ts": 6,
  "tournament-substitutes.spec.ts": 5,
  "tournament-edge-cases.spec.ts": 5,
  "views.spec.ts": 5,
  "import-share-code.spec.ts": 5,
  "player-blocks.spec.ts": 5,
};
const DEFAULT_WEIGHT = 2;

const weightOf = (test) => WEIGHTS[basename(test.path)] ?? DEFAULT_WEIGHT;

class SlowFirstSequencer extends Sequencer {
  // Longest-first greedy packing: each suite goes to the shard with the least
  // work so far. The order is fixed by weight, then path, so every shard
  // computes the same split.
  shard(tests, { shardIndex, shardCount }) {
    const ordered = [...tests].sort(
      (a, b) =>
        weightOf(b) - weightOf(a) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

    const loads = new Array(shardCount).fill(0);
    const mine = [];
    for (const test of ordered) {
      const lightest = loads.indexOf(Math.min(...loads));
      loads[lightest] += weightOf(test);
      if (lightest === shardIndex - 1) {
        mine.push(test);
      }
    }
    return mine;
  }

  // Heavy suites first; everything else keeps jest's default order behind them.
  sort(tests) {
    return super.sort(tests).sort((a, b) => weightOf(b) - weightOf(a));
  }
}

module.exports = SlowFirstSequencer;
