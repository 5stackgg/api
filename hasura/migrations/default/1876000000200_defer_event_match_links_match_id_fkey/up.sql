-- Safety net for the same ordering hazard v_event_matches now guards against:
-- schedule_tournament_match() deliberately points tournament_brackets.match_id
-- at a matches row it has not inserted yet (that FK is DEFERRABLE INITIALLY
-- DEFERRED so tai_match can see the bracket link). Any trigger that fires in
-- that window and derives a link from a bracket would hit an immediate FK here
-- and abort the caller's whole transaction -- which is how starting a
-- tournament attached to an event broke. Deferring the check to commit means
-- such a link is judged once the matches insert has landed.
alter table "public"."event_match_links"
  alter constraint "event_match_links_match_id_fkey"
    deferrable initially deferred;
