DROP TRIGGER IF EXISTS tbiu_friends ON public.friends;
DROP FUNCTION IF EXISTS public.tbiu_friends();

DROP TRIGGER IF EXISTS tbi_lobby_players ON public.lobby_players;
DROP FUNCTION IF EXISTS public.tbi_lobby_players();

DROP TRIGGER IF EXISTS tbi_tournament_team_invites ON public.tournament_team_invites;
DROP FUNCTION IF EXISTS public.tbi_tournament_team_invites();

DROP TRIGGER IF EXISTS tbi_event_players_not_blocked ON public.event_players;
DROP TRIGGER IF EXISTS tbi_event_organizers_not_blocked ON public.event_organizers;
DROP TRIGGER IF EXISTS tbi_tournament_organizers_not_blocked ON public.tournament_organizers;
DROP FUNCTION IF EXISTS public.tbi_assert_session_not_blocked();

DROP TABLE IF EXISTS public.player_blocks;
DROP FUNCTION IF EXISTS public.tbi_player_blocks();
DROP FUNCTION IF EXISTS public.tai_player_blocks();

DROP FUNCTION IF EXISTS public.assert_session_not_blocked(bigint, text);
DROP FUNCTION IF EXISTS public.assert_not_blocked(bigint, bigint);
DROP FUNCTION IF EXISTS public.is_blocked_either_way(bigint, bigint);
DROP FUNCTION IF EXISTS public.has_blocked_player(bigint, bigint);

-- HasuraService.apply skips a boot-phase file whose digest is unchanged, so every
-- file this feature added or edited must lose its digest: the rolled-back code
-- then re-applies its own versions (without the calls into the functions
-- dropped above), and a later forward deploy recreates everything here.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/functions/players/assert_not_blocked',
      'hasura/functions/players/assert_session_not_blocked',
      'hasura/functions/players/has_blocked_player',
      'hasura/functions/players/is_blocked_either_way',
      'hasura/triggers/draft_game_players',
      'hasura/triggers/friends',
      'hasura/triggers/league_team_rosters',
      'hasura/triggers/lobby_players',
      'hasura/triggers/match_lineup_players',
      'hasura/triggers/player_blocks',
      'hasura/triggers/team_invite',
      'hasura/triggers/tournament_invites',
      'hasura/triggers/tournament_team_invites',
      'hasura/triggers/tournament_team_roster'
    );
  END IF;
END $$;
