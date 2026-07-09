insert into e_plugin_runtimes ("value", "description") values
    ('swiftlys2', 'Plugin loads under the SwiftlyS2 framework'),
    ('counterstrikesharp', 'Plugin loads under Metamod and CounterStrikeSharp')
on conflict(value) do update set "description" = EXCLUDED."description"
