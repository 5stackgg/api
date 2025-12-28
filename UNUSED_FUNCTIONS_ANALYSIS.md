# Function Usage Analysis

## Summary
All tournament functions appear to be **USED**. No unused functions found.

## Function Usage Details

### ✅ All Functions Are Used

#### Core Tournament Functions
- `advance_round_robin_teams` - Used in `update_tournament_bracket.sql`
- `advance_byes_for_tournament` - Used in `seed_stage.sql`
- `assign_seeds_to_teams` - Used in `triggers/tournaments.sql`
- `assign_team_to_bracket_slot` - Used in `update_tournament_bracket.sql` and `schedule_tournament_match.sql`
- `check_round_robin_stage_complete` - Used in `update_tournament_bracket.sql`
- `check_team_eligibility` - Used in `triggers/tournament_team_roster.sql`
- `check_tournament_finished` - Used in `update_tournament_bracket.sql`
- `create_round_robin_matches` - Used in `update_tournament_stages.sql`
- `delete_tournament_brackets_and_matches` - Used in `triggers/tournaments.sql` and `update_tournament_stages.sql`
- `generate_bracket_order` - Used in `update_tournament_stages.sql`
- `get_stage_team_counts` - Used in `update_tournament_stages.sql`
- `get_team_next_round_bracket_id` - Used in `schedule_next_round_robin_matches.sql`
- `is_tournament_match` - Used in `triggers/matches.sql` and Hasura metadata
- `is_tournament_organizer` - Used in Hasura metadata (computed field)
- `link_round_group_matches` - Used in `link_tournament_stage_matches.sql`
- `link_stage_brackets` - Used in `link_tournament_stages.sql`
- `link_tournament_stage_matches` - Used in `update_tournament_stages.sql`
- `link_tournament_stages` - Used in `update_tournament_stages.sql`
- `opponent_finished_previous_round` - Used in `schedule_next_round_robin_matches.sql`
- `schedule_next_round_robin_matches` - Used in `update_tournament_bracket.sql`
- `schedule_tournament_match` - Used in `update_tournament_bracket.sql` and `schedule_next_round_robin_matches.sql`
- `seed_stage` - Used in `advance_round_robin_teams.sql`
- `tournament_bracket_eta` - Used as computed field in Hasura metadata
- `tournament_has_min_teams` - Used in `can_start_tournament.sql`, `can_close_tournament_registration.sql`, `triggers/tournaments.sql`, and Hasura metadata
- `tournament_max_players_per_lineup` - Used in `check_team_eligibility.sql` and Hasura metadata
- `tournament_min_players_per_lineup` - Used in `check_team_eligibility.sql` and Hasura metadata
- `update_tournament_bracket` - Used in `triggers/matches.sql`
- `update_tournament_stages` - Used in `triggers/tournaments.sql`
- `calculate_tournament_bracket_start_times` - Used in `update_tournament_stages.sql` and `schedule_tournament_match.sql`

#### Permission Functions (All Used in Hasura Metadata)
- `can_cancel_tournament` - Used in `triggers/tournaments.sql` and Hasura metadata
- `can_close_tournament_registration` - Used in `triggers/tournaments.sql` and Hasura metadata
- `can_join_tournament` - Used in Hasura metadata
- `can_open_tournament_registration` - Used in `triggers/tournaments.sql` and Hasura metadata
- `can_start_tournament` - Used in Hasura metadata

## Notes
- All functions are either:
  1. Called by other functions/triggers
  2. Used as computed fields in Hasura GraphQL schema
  3. Used in permission checks via triggers

- No orphaned or unused functions detected in the tournaments directory.


