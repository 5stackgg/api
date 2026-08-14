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
  // A 1:1 private conversation. The id is the two participants' steam ids
  // sorted ascending and joined with ":", so both sides derive the same room
  // with no lookup and no row to allocate. See utilities/directRoomId.ts.
  Direct = "direct",
}
