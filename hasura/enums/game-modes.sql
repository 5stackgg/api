-- The starter modes themselves are created once, by the 1889000001400
-- migration, so an operator can delete one for good. What runs on every boot is
-- only the wiring: the registry syncs on its own schedule, so on a fresh install
-- the modes exist before their plugins do and pick them up on a later pass. A
-- mode that already selects plugins is the operator's, and is left alone.
insert into game_mode_plugins (game_mode_id, plugin_slug, load_order)
select m.id, starter.plugin_slug, 0
  from (values
          ('deathmatch', 'deathmatch'),
          ('retakes', 'retakes'),
          ('arenas', 'arenas'),
          ('chaos', 'csroll')
       ) as starter (mode_slug, plugin_slug)
  join game_modes m on m.slug = starter.mode_slug
  join game_plugins p on p.slug = starter.plugin_slug
 where not exists (
         select 1 from game_mode_plugins existing
          where existing.game_mode_id = m.id
       )
on conflict (game_mode_id, plugin_slug) do nothing;
