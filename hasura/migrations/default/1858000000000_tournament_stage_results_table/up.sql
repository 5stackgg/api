-- v_team_stage_results: view -> trigger-maintained cache table. Heavy logic
-- stays as v_team_stage_results_compute (hasura/views); recompute is per-stage.
-- Migrations run before the auto-loader, so this only does view-independent DDL.
DROP VIEW IF EXISTS public.v_team_tournament_results;
DROP VIEW IF EXISTS public.v_team_stage_results;

CREATE TABLE IF NOT EXISTS public.v_team_stage_results (
    tournament_team_id       uuid             NOT NULL,
    tournament_stage_id      uuid             NOT NULL,
    matches_played           int              NOT NULL DEFAULT 0,
    matches_remaining        int              NOT NULL DEFAULT 0,
    wins                     int              NOT NULL DEFAULT 0,
    losses                   int              NOT NULL DEFAULT 0,
    maps_won                 int              NOT NULL DEFAULT 0,
    maps_lost                int              NOT NULL DEFAULT 0,
    rounds_won               int              NOT NULL DEFAULT 0,
    rounds_lost              int              NOT NULL DEFAULT 0,
    total_kills              int              NOT NULL DEFAULT 0,
    total_deaths             int              NOT NULL DEFAULT 0,
    team_kdr                 double precision NOT NULL DEFAULT 0,
    head_to_head_match_wins  int              NOT NULL DEFAULT 0,
    head_to_head_rounds_won  int              NOT NULL DEFAULT 0,
    group_number             int              NOT NULL DEFAULT 1,
    rank                     int              NOT NULL,
    placement                int              NOT NULL,
    CONSTRAINT v_team_stage_results_pkey
        PRIMARY KEY (tournament_stage_id, tournament_team_id)
);

CREATE INDEX IF NOT EXISTS v_team_stage_results_team_idx
    ON public.v_team_stage_results (tournament_team_id);
