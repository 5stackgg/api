delete from "public"."match_clips" where "user_steam_id" is null;

alter table "public"."match_clips"
  alter column "user_steam_id" set not null;
