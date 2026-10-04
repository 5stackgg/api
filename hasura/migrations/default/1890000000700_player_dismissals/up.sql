-- Alerts a player has chosen to stop seeing, one row per alert, so a dismissal
-- follows them to every browser and device. `key` names the alert (e.g.
-- `team_roster_need:<team_id>`); `value` holds whatever the alert needs to
-- decide when it should come back.
CREATE TABLE IF NOT EXISTS public.player_dismissals (
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    key text NOT NULL,
    value jsonb,
    dismissed_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (player_steam_id, key)
);
