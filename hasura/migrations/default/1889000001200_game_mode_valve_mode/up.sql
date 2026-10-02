ALTER TABLE public.game_modes
    ADD COLUMN IF NOT EXISTS valve_mode text;

ALTER TABLE public.game_modes
    DROP CONSTRAINT IF EXISTS game_modes_valve_mode_check;

-- Keys of the modes in CS2's gamemodes.txt. NULL is stock Custom.
ALTER TABLE public.game_modes
    ADD CONSTRAINT game_modes_valve_mode_check CHECK (
        valve_mode IN (
            'casual',
            'competitive',
            'wingman',
            'retakes',
            'rush',
            'armsrace',
            'deathmatch'
        )
    );

-- The Deathmatch plugin patches Valve's deathmatch rules, so the starter mode
-- only spawns players randomly on that Valve mode.
UPDATE public.game_modes
   SET valve_mode = 'deathmatch'
 WHERE slug = 'deathmatch'
   AND valve_mode IS NULL;
