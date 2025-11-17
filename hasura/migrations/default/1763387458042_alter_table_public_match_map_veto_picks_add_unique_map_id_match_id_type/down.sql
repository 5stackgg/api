alter table "public"."match_map_veto_picks" drop constraint "match_map_veto_picks_map_id_match_id_type_key";
alter table "public"."match_map_veto_picks" add constraint "match_map_veto_picks_map_id_match_id_key" unique ("map_id", "match_id");
