-- Make tournament_brackets.match_id -> matches.id FK deferrable so that
-- schedule_tournament_match() can link the bracket to its match BEFORE
-- inserting the matches row. With the link in place at INSERT time,
-- is_tournament_match(NEW) is honest inside tai_match and the standalone
-- "auto-add organizer to lineup_1" fallback is correctly skipped for
-- tournament matches.
alter table "public"."tournament_brackets"
  drop constraint "tournament_brackets_match_id_fkey",
  add constraint "tournament_brackets_match_id_fkey"
    foreign key ("match_id")
    references "public"."matches" ("id")
    on update cascade
    on delete set null
    deferrable initially deferred;
