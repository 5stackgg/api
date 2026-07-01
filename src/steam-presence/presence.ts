export const CS2_APP_ID = 730;

// CS2 matchmaking modes whose demos we can import via match-sharing codes.
// These are the values CS2 reports in the `game:mode` rich-presence key.
const MATCHMAKING_MODES = new Set([
  "competitive",
  "premier",
  "scrimcomp2v2", // wingman
  "scrimcomp5v5",
  "wingman",
]);

export type Cs2PresenceState = {
  // Player is currently running CS2 (gameid === 730).
  inCs2: boolean;
  // Player is in ANY active game (deathmatch, casual, custom/5stack, MM, …) as
  // opposed to the main menu / lobby. Drives the "what the bot sees" display.
  inGame: boolean;
  // Player is in an active matchmaking match we can import (comp/premier/wingman).
  // Narrower than inGame — this is what triggers the history poll.
  inMatch: boolean;
  // Raw `game:mode` (e.g. competitive, premier, scrimcomp2v2, deathmatch, casual,
  // survival, "" for custom servers). null when unknown.
  mode: string | null;
  map: string | null;
  // Current map score, e.g. "5:3" (from `game:score`). null when not in a game.
  score: string | null;
  // Steam's own localized friends-list string, e.g. "Deathmatch - Dust II".
  // The most reliable label — mirrors exactly what Steam shows. null if absent.
  display: string | null;
};

type RawRichPresence =
  | Record<string, string>
  | Array<{ key?: string; value?: string }>
  | null
  | undefined;

export type PresenceInput = {
  // steam-user reports the app being played as a numeric-ish id (string).
  gameid?: string | number | null;
  // Rich presence as either the steam-user array form ([{key,value}]) or a map.
  richPresence?: RawRichPresence;
  // Steam's localized display string, if available.
  display?: string | null;
};

function normalizeRichPresence(rp: RawRichPresence): Record<string, string> {
  if (!rp) {
    return {};
  }
  if (Array.isArray(rp)) {
    const map: Record<string, string> = {};
    for (const entry of rp) {
      if (entry?.key != null && entry.value != null) {
        map[entry.key] = entry.value;
      }
    }
    return map;
  }
  return rp;
}

// Best-effort: CS2 doesn't expose a single boolean for "in a match", so we infer
// it from the matchmaking mode plus the in-game signals. The exact key values
// must be confirmed against real captured presence (see presence.spec.ts); this
// is intentionally isolated so the heuristic is cheap to adjust.
function looksInGame(state: string | undefined, display: string | undefined): boolean {
  if (state && state.toLowerCase() === "game") {
    return true;
  }
  if (!display) {
    return false;
  }
  const d = display.toLowerCase();
  if (d.includes("menu") || d.includes("lobby")) {
    return false;
  }
  // e.g. #display_GameKnownMapScore, #display_GameWithMapScore
  return d.includes("game") || d.includes("map") || d.includes("score");
}

export function parseCs2Presence(input: PresenceInput): Cs2PresenceState {
  const rp = normalizeRichPresence(input.richPresence);

  // CS2 publishes rich presence while running (at least steam_display
  // = #display_Menu in the menu), so any CS2 key means in-CS2 — a useful
  // fallback when the persona gameid isn't set on the push event.
  const hasCs2Keys = Object.keys(rp).some(
    (k) => k === "steam_display" || k === "status" || k.startsWith("game:"),
  );
  const inCs2 =
    hasCs2Keys ||
    (input.gameid != null && String(input.gameid) === String(CS2_APP_ID));

  const mode = rp["game:mode"]?.toLowerCase() ?? null;
  const rawMap = rp["game:map"] ?? null;
  const map = rawMap ? rawMap.replace(/^mg_/, "") : null;

  // In a game of any kind — covers deathmatch/casual/custom/5stack too. A
  // custom-server match often reports no game:mode but still has a map + game
  // state, so we don't require a known mode here.
  const inGame = inCs2 && looksInGame(rp["game:state"], rp["steam_display"]);

  // Narrow: only the matchmaking modes whose demos we import via share codes.
  const inMatch = inGame && mode != null && MATCHMAKING_MODES.has(mode);

  // "5 : 3" / "5:3" -> "5:3". Only meaningful while in a game.
  const rawScore = rp["game:score"] ?? null;
  const score = inGame && rawScore ? rawScore.replace(/\s+/g, "") : null;

  const display = input.display?.trim() || null;

  return { inCs2, inGame, inMatch, mode, map, score, display };
}

// Whether a state change should trigger an immediate match-history poll for the
// user: they were in a match and now are not (match ended / left the game).
export function isMatchEndTransition(
  previous: Cs2PresenceState | null,
  current: Cs2PresenceState,
): boolean {
  return previous?.inMatch === true && current.inMatch === false;
}
