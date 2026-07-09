# League SQL test suites

End-to-end verification of the CAL-style league system, written as plain
psql scripts with `RAISE EXCEPTION` assertions. They cover:

| Suite | Covers |
| --- | --- |
| `01_lifecycle.sql` | Registration guards, season start (tournament materialization, bracket dormancy), scheduling negotiation, default-time fallback, roster lock, forfeits, standings, playoff seeding, movements, next-season auto-slot |
| `02_best_of.sql` | Per-week and per-playoff-round best-of resolution at match materialization, mid-season format edits propagating to unplayed matches |
| `03_playoff_formats.sql` | Double-elimination playoffs through a BO5 grand final, single-elim with a third-place decider, captain scheduling of playoff matchups, structural locks after season start |
| `04_enhancements.sql` | Dual-roster block, non-rostered lineup rejection, post-materialization renegotiation, mid-season team removal with `Remove` movements, season rollover cloning, notification type seeds |

## Setup

Run against a **disposable** database with the full schema loaded the same
way the API boots it (`src/hasura/hasura.service.ts#setup`):

1. Create a database with `pgcrypto` and `pg_stat_statements`, and
   `check_function_bodies = off` (the SQL sources load in alphabetical order
   and reference each other).
2. Apply `hasura/migrations/default/*/up.sql` in version order.
3. Apply every `.sql` file under `hasura/enums`, then `hasura/functions`,
   then `hasura/views`, then `hasura/triggers` (alphabetical within each).
4. If TimescaleDB is not installed, stub `create_hypertable` before applying
   the migrations:
   `CREATE FUNCTION create_hypertable(rel text, time_col text, migrate_data boolean DEFAULT false) RETURNS text LANGUAGE sql AS $$ SELECT rel; $$;`

The suites set the `hasura.user` and `fivestack.app_key` GUCs themselves
(triggers read them), create their own fixture data (players, teams, maps,
a server region) and `cleanup.sql` removes it between runs.

## Run

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=league_test \
  ./run.sh
```

# Deploying the league feature

1. Apply migrations and Hasura metadata (`yarn hasura:migrate apply`,
   `yarn hasura:metadata`). Metadata apply activates the two league event
   triggers (`league_proposal_events`, `league_registration_events`) that
   drive notifications.
2. Enable the feature flag: App Settings → Leagues, or set the
   `public.leagues_enabled` settings row to `true`.
3. In the web repo, run `yarn codegen` against the live instance so the
   generated client includes the league tables (the league pages use raw
   gql documents and work without it, but typed usage and the tournaments
   list filter benefit from regenerated types).
4. Verify the league cron jobs appear in the queue dashboard
   (`/queues`): `CheckLeagueSeasonTransitions`, `ApplyLeagueDefaultSchedules`,
   `LeagueWeekReminders`.
5. Create the league, divisions, and first season; the admin "Season
   readiness" panel on the season page shows what is missing before kickoff
   (divisions need at least 4 approved teams to run).
