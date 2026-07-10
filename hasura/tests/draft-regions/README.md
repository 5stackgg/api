# Draft-region guard SQL test suite

Regression tests for the "draft lobby stuck with no regions" bug: when no
server region had any attached servers, a draft lobby could still be created
and started, then `DraftMatchService.finalize` died on the match insert
(`sanitize_match_options_regions` raises) after already setting the draft to
`CreatingMatch`. Nothing ever cleans a `CreatingMatch` row (the expiry job
only deletes `Open` drafts) and its players stay locked out of every other
lobby. Similarly, starting a match whose selected region lost its servers
silently bounced Live → Veto with no error.

| Suite | Covers |
| --- | --- |
| `01_no_region_guards.sql` | Draft creation/start refused with no available regions, lobby stays `Open` on refusal, match insert refusal (the finalize safety-net trigger), start working again once a server returns, match start refused when the selected region has no servers, cancel/delete always working, live matches unaffected by the guard |

The guards under test:

- `has_available_server_region()` — true when any `server_regions` row has
  `total_region_server_count > 0` (same notion the sanitizer uses).
- `tbi_draft_games` / `tbu_draft_games` (`Open -> Filled`) raise
  `No game server regions are currently available`.
- `tbu_matches` raises `No game servers are available in region <x>` on a
  non-Live → Live transition when the selected region has no servers.
- The API-side safety net (`DraftMatchService.finalize` canceling the draft
  when match creation fails) is TypeScript and not covered here.

## Setup + run

Same disposable-database setup as the leagues suites — see
`../leagues/README.md`. Then:

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=draft_test \
  ./run.sh
```
