alter table "public"."tournament_brackets" add column if not exists "loser_parent_bracket_id" uuid null;

alter table "public"."tournament_brackets" add column if not exists "path" text
 null;

create index if not exists "tournament_brackets_loser_parent_idx"
  on "public"."tournament_brackets" ("loser_parent_bracket_id");

create index if not exists "tournament_brackets_path_idx"
  on "public"."tournament_brackets" ("path");


