import { e_match_types_enum } from "generated";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

/**
 * A party may queue a match type when it either fits inside a single lineup
 * (half the match, matchmaking fills the other half) or fills the entire match
 * on its own (both lineups, split in-house). Anything between those two — or
 * anything above the full match size — cannot be placed.
 *
 * Duel (2): 1 or 2 · Wingman (4): 1-2 or 4 · Competitive (10): 1-5 or 10
 */
export function canPartyQueue(
  type: e_match_types_enum,
  partySize: number,
): boolean {
  const expected = ExpectedPlayers[type];

  if (!expected) {
    return true;
  }

  if (partySize < 1) {
    return false;
  }

  return partySize <= expected / 2 || partySize === expected;
}

/**
 * Returns the reason a party cannot queue the given type, or undefined when it
 * can. Used for the JoinQueueError message surfaced to every lobby member.
 */
export function getPartySizeError(
  type: e_match_types_enum,
  partySize: number,
): string | undefined {
  if (canPartyQueue(type, partySize)) {
    return;
  }

  const expected = ExpectedPlayers[type];

  return `To join a ${type} match, your lobby must have ${expected / 2} or fewer players, or exactly ${expected} players. You have ${partySize}.`;
}
