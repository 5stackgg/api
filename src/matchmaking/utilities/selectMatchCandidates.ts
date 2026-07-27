import { MatchmakingLobby } from "../types/MatchmakingLobby";
import { MatchCandidates } from "../types/BalancedTeams";
import { getRankWindow } from "./matchmakingTuning";

export interface SelectMatchCandidatesOptions {
  now?: number;
  // when false, out of window lobbies are dropped even if that means no match
  softWindow?: boolean;
}

/** joinedAt comes back off redis as a string, despite the type on MatchmakingLobby. */
export function joinedAtMillis(joinedAt: Date | string) {
  const millis =
    joinedAt instanceof Date
      ? joinedAt.getTime()
      : new Date(joinedAt).getTime();

  return Number.isFinite(millis) ? millis : 0;
}

function totalPlayers(lobbies: MatchmakingLobby[]) {
  return lobbies.reduce((acc, lobby) => acc + lobby.players.length, 0);
}

/**
 * Picks the anchor - the longest waiting lobby, which must end up in the match
 * so nobody starves at the tail of the queue - and orders every other lobby by
 * how well it pairs with that anchor.
 *
 * Returns the full ordered list rather than a truncated window; the caller
 * claims from the front and stops at WINDOW_CAP, so lobbies that fail to claim
 * are topped up from the tail.
 */
export function selectMatchCandidates(
  lobbies: MatchmakingLobby[],
  requiredPlayers: number,
  options?: SelectMatchCandidatesOptions,
): MatchCandidates | null {
  const now = options?.now ?? Date.now();
  const softWindow = options?.softWindow ?? true;
  const playersPerTeam = requiredPlayers / 2;

  // a lobby larger than a lineup can never fit; one that fills the whole match
  // was already handled by the self split path
  const usable = lobbies.filter(
    (lobby) =>
      lobby.players.length > 0 && lobby.players.length <= playersPerTeam,
  );

  if (totalPlayers(usable) < requiredPlayers) {
    return null;
  }

  const [anchor] = [...usable].sort((a, b) => {
    const waitDiff = joinedAtMillis(a.joinedAt) - joinedAtMillis(b.joinedAt);
    return waitDiff !== 0 ? waitDiff : a.lobbyId.localeCompare(b.lobbyId);
  });

  const window = getRankWindow((now - joinedAtMillis(anchor.joinedAt)) / 1000);

  const rest = usable
    .filter((lobby) => lobby.lobbyId !== anchor.lobbyId)
    .sort((a, b) => {
      const rankDiff =
        Math.abs(a.avgRank - anchor.avgRank) -
        Math.abs(b.avgRank - anchor.avgRank);
      if (rankDiff !== 0) {
        return rankDiff;
      }

      const waitDiff = joinedAtMillis(a.joinedAt) - joinedAtMillis(b.joinedAt);
      return waitDiff !== 0 ? waitDiff : a.lobbyId.localeCompare(b.lobbyId);
    });

  const inWindow = rest.filter(
    (lobby) => Math.abs(lobby.avgRank - anchor.avgRank) <= window,
  );

  // enforce the window whenever it can still produce a match, otherwise demote
  // the out of window lobbies instead of dropping them so a thin queue still
  // plays rather than waiting for the window to widen
  if (totalPlayers([anchor, ...inWindow]) >= requiredPlayers) {
    return { anchor, candidates: [anchor, ...inWindow] };
  }

  if (!softWindow) {
    return null;
  }

  const outOfWindow = rest.filter(
    (lobby) => Math.abs(lobby.avgRank - anchor.avgRank) > window,
  );

  return { anchor, candidates: [anchor, ...inWindow, ...outOfWindow] };
}
