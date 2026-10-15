export type TwitchPlayerStream = {
  steam_id: string;
  login: string;
  display_name: string | null;
  is_live: boolean;
  title: string | null;
  game_name: string | null;
  viewer_count: number | null;
  started_at: Date | null;
  thumbnail_url: string | null;
};

export type TwitchMatchStream = {
  steam_id: string;
  name: string;
  avatar_url: string | null;
  match_lineup_id: string;
  login: string;
  display_name: string | null;
  title: string | null;
  viewer_count: number | null;
  started_at: Date | null;
  thumbnail_url: string | null;
};

export type TwitchMe = {
  enabled: boolean;
  account: {
    twitch_user_id: string;
    login: string;
    display_name: string | null;
    is_live: boolean;
    title: string | null;
    game_name: string | null;
    viewer_count: number | null;
    started_at: Date | null;
    thumbnail_url: string | null;
    checked_at: Date | null;
    linked_at: Date;
  } | null;
};
