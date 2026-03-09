import { v4 as uuid } from "uuid";

export function buildMatch(overrides: Partial<any> = {}) {
  return {
    id: uuid(),
    status: "Scheduled",
    match_options_id: uuid(),
    organizer_steam_id: "76561198000000001",
    type: "Competitive",
    region: "eu-west",
    cancels_at: null,
    ...overrides,
  };
}

export function buildPlayer(overrides: Partial<any> = {}) {
  return {
    steam_id: "76561198000000001",
    name: "TestPlayer",
    role: "user",
    is_banned: false,
    matchmaking_cooldown: false,
    ...overrides,
  };
}

export function buildLineup(overrides: Partial<any> = {}) {
  return {
    id: uuid(),
    match_id: uuid(),
    name: "Team A",
    is_ready: false,
    lineup_players: [],
    ...overrides,
  };
}

export function buildMatchOptions(overrides: Partial<any> = {}) {
  return {
    id: uuid(),
    mr: 12,
    best_of: 1,
    type: "Competitive",
    map_pool_id: uuid(),
    ...overrides,
  };
}

export function buildTournament(overrides: Partial<any> = {}) {
  return {
    id: uuid(),
    status: "RegistrationOpen",
    organizer_steam_id: "76561198000000001",
    name: "Test Tournament",
    ...overrides,
  };
}

export function buildTournamentBracket(overrides: Partial<any> = {}) {
  return {
    id: uuid(),
    tournament_stage_id: uuid(),
    round: 1,
    match_number: 1,
    finished: false,
    bye: false,
    tournament_team_id_1: null,
    tournament_team_id_2: null,
    match_id: null,
    parent_bracket_id: null,
    loser_parent_bracket_id: null,
    ...overrides,
  };
}
