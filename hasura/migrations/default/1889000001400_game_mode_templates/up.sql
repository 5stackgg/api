ALTER TABLE public.game_modes
    ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;

UPDATE public.game_modes SET system = true WHERE slug = 'utility-practice';

-- Starter modes, offered once. From then on they are the operator's like any
-- other mode: deleting one keeps it gone, which an every-boot seed would undo.
-- hasura/enums/game-modes.sql wires each to its plugin once the registry has it.
INSERT INTO public.game_modes (slug, name, description, competitive_safe, enabled, cfg, valve_mode)
VALUES
    (
        'deathmatch',
        'Deathmatch',
        'Free-for-all warmup with instant respawns and a weapon menu.',
        false,
        true,
        'mp_maxrounds 0' || chr(10) ||
        'mp_freezetime 0' || chr(10) ||
        'mp_respawn_immunitytime 2' || chr(10) ||
        'mp_ignore_round_win_conditions 1' || chr(10) ||
        'mp_teammates_are_enemies 1',
        'deathmatch'
    ),
    (
        'retakes',
        'Retakes',
        'Bombsite retakes: the bomb is planted, T''s defend, CT''s retake. Fast rounds, no buy time.',
        false,
        true,
        'mp_maxrounds 0' || chr(10) ||
        'mp_freezetime 3' || chr(10) ||
        'mp_round_restart_delay 3' || chr(10) ||
        'mp_ignore_round_win_conditions 1' || chr(10) ||
        'mp_respawn_on_death_ct 0' || chr(10) ||
        'mp_respawn_on_death_t 0',
        NULL
    ),
    (
        'arenas',
        '1v1 Arenas',
        'Ladder arenas: win and climb, lose and drop. Aim practice that keeps a full server busy.',
        false,
        true,
        'mp_maxrounds 0' || chr(10) ||
        'mp_freezetime 3' || chr(10) ||
        'mp_ignore_round_win_conditions 1' || chr(10) ||
        'mp_respawn_on_death_ct 0' || chr(10) ||
        'mp_respawn_on_death_t 0',
        NULL
    ),
    (
        'chaos',
        'Chaos',
        'Players roll gameplay-altering effects — jetpack, wallhack, speedhack, vampire, infinite ammo and ~40 more — scoped to a round, a run of rounds, or the whole match, server-wide or per player.',
        false,
        true,
        NULL,
        'competitive'
    )
ON CONFLICT (slug) DO NOTHING;

-- An early utility build installed its practice mode as nade-practice; the
-- utility system has used utility-practice since, so the old row is litter.
DELETE FROM public.game_modes m
 WHERE m.slug = 'nade-practice'
   AND NOT EXISTS (
       SELECT 1 FROM public.match_options mo WHERE mo.game_mode_id = m.id
   );

UPDATE public.game_modes
   SET archived_at = now(), enabled = false
 WHERE slug = 'nade-practice'
   AND archived_at IS NULL;
