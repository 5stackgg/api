-- Starter modes, seeded on every boot so a fresh install has something to pick
-- besides "Competitive". Enum-style upsert: the name and description follow the
-- ship, but enabled / competitive_safe / cfg are left alone once an operator has
-- touched them, and anything they add of their own is untouched.
--
-- Runtime compatibility is NOT declared here. It is derived from the plugins
-- each mode selects, so a mode whose plugin has no build for this deployment
-- reports that by name rather than booting a server with nothing loaded.
insert into game_modes (slug, name, description, competitive_safe, enabled, cfg)
values
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
        'mp_respawn_on_death_t 0'
    ),
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
        'mp_teammates_are_enemies 1'
    )
on conflict (slug) do update set
    name = excluded.name,
    description = excluded.description;

-- Wire each starter mode to its plugin, but only once that plugin is in the
-- catalog: the registry syncs on its own schedule, so on a first boot these
-- modes exist with no plugins and pick them up on a later pass.
insert into game_mode_plugins (game_mode_id, plugin_slug, load_order)
select m.id, p.slug, 0
  from game_modes m
  join game_plugins p on p.slug = m.slug
 where m.slug in ('retakes', 'deathmatch')
on conflict (game_mode_id, plugin_slug) do nothing;
