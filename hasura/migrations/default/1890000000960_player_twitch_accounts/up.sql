-- A player's Twitch account, proven by OAuth rather than typed in. No Twitch
-- token is kept: the link stores who they are on Twitch, and the api's poller
-- fills in whether they are live in Counter-Strike right now. No role may read
-- it through Hasura -- the api serves it, which is where the rule that keeps a
-- stream from the players of the live match it shows is enforced.
CREATE TABLE IF NOT EXISTS public.player_twitch_accounts (
    steam_id bigint PRIMARY KEY REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    twitch_user_id text NOT NULL UNIQUE,
    login text NOT NULL,
    display_name text,
    is_live boolean NOT NULL DEFAULT false,
    stream_title text,
    game_name text,
    viewer_count integer,
    started_at timestamptz,
    thumbnail_url text,
    checked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_twitch_accounts_live
    ON public.player_twitch_accounts (steam_id)
    WHERE is_live;
