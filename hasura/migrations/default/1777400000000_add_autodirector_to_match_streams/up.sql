-- Persist the spectator auto-director toggle so it survives page
-- reloads + caster handoffs + streamer pod restarts. Without this the
-- web UI defaulted to "on" every render even if a caster had just
-- flipped it off, and a new pod boot lost the operator's choice.
--
-- Default true mirrors what the autoexec in run-live writes into cs2
-- at launch (spec_autodirector 1 via run-live.sh's HIDE_UI_CMDS path).
-- Only meaningful for is_game_streamer = true rows.
alter table "public"."match_streams"
  add column if not exists "autodirector" boolean not null default true;
