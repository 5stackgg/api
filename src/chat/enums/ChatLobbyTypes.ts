export enum ChatLobbyType {
  Match = "match",
  // One side of a match only, keyed `${matchId}:${lineupId}`. Distinct from
  // Team, which is a real team's permanent room -- matchmaking and draft
  // lineups are ad-hoc and have no team behind them.
  MatchTeam = "match_team",
  Team = "team",
  MatchMaking = "matchmaking",
  Tournament = "tournament",
  Organizer = "organizers",
  Draft = "draft",
}
