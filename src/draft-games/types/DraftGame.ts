import {
  e_match_types_enum,
  e_draft_game_mode_enum,
  e_draft_game_status_enum,
  e_draft_game_draft_order_enum,
  e_draft_game_captain_selection_enum,
} from "generated";

export interface DraftGamePlayer {
  steam_id: string;
  name: string;
  avatar_url?: string;
  elo_snapshot?: number;
  is_captain: boolean;
  lineup?: number;
  pick_order?: number;
  status?: string;
  joined_at?: string;
}

export interface DraftGame {
  id: string;
  host_steam_id: string;
  status: e_draft_game_status_enum;
  type: e_match_types_enum;
  mode: e_draft_game_mode_enum;
  access: string;
  invite_code?: string;
  regions: Array<string>;
  map_pool_id?: string;
  match_options_id?: string;
  team_1_id?: string;
  team_2_id?: string;
  inner_squad?: boolean;
  captain_selection: e_draft_game_captain_selection_enum;
  draft_order: e_draft_game_draft_order_enum;
  min_elo?: number;
  max_elo?: number;
  capacity: number;
  require_approval: boolean;
  match_id?: string;
  current_pick_lineup?: number;
  pick_deadline?: string;
  created_at?: string;
  players: Array<DraftGamePlayer>;
}
