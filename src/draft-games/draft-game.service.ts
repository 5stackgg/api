import { Queue } from "bullmq";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { InjectQueue } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import {
  e_match_types_enum,
  e_lobby_access_enum,
  e_player_roles_enum,
  e_draft_game_mode_enum,
  e_draft_game_draft_order_enum,
  e_draft_game_player_status_enum,
  e_draft_game_captain_selection_enum,
} from "generated";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { DraftGame } from "./types/DraftGame";
import { DraftGameError } from "./types/DraftGameError";
import { DraftGameQueues } from "./enums/DraftGameQueues";
import { DraftService } from "./draft.service";

export interface CreateDraftGameSettings {
  type: e_match_types_enum;
  mode?: e_draft_game_mode_enum;
  access?: string;
  require_approval?: boolean;
  regions: Array<string>;
  map_pool_id?: string;
  captain_selection: e_draft_game_captain_selection_enum;
  draft_order: e_draft_game_draft_order_enum;
  min_elo?: number;
  max_elo?: number;
  team_1_id?: string;
  team_2_id?: string;
  inner_squad?: boolean;
  roster?: Array<DraftRosterEntry>;
  keep_lobby_together?: boolean;
  host_joins?: boolean;
  options?: Record<string, unknown>;
}

export interface DraftRosterEntry {
  steam_id: string;
  lineup: number | null;
  // Which side this player belongs to even when benched, so backups stay
  // pinned to the team they would sub for.
  side?: number | null;
}

@Injectable()
export class DraftGameService {
  public static readonly DRAFTABLE_TYPES: e_match_types_enum[] = [
    "Competitive",
    "Wingman",
    "Duel",
  ];

  public static readonly DEFAULT_ELO = 5000;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly cache: CacheService,
    @Inject(forwardRef(() => DraftService))
    private readonly draftService: DraftService,
    @InjectQueue(DraftGameQueues.DraftGames) private queue: Queue,
  ) {}

  public static lockKey(draftGameId: string): string {
    return `draft-game:${draftGameId}`;
  }

  private draftLock<T>(draftGameId: string, callback: () => Promise<T>) {
    return this.cache.lock(
      DraftGameService.lockKey(draftGameId),
      callback,
    ) as Promise<T>;
  }

  private playerLock<T>(steamId: string, callback: () => Promise<T>) {
    return this.cache.lock(
      `draft-game:player:${steamId}`,
      callback,
    ) as Promise<T>;
  }

  private isOrganizerOrHost(
    user: User,
    draftGame: Pick<DraftGame, "host_steam_id">,
  ): boolean {
    return (
      user.steam_id === draftGame.host_steam_id ||
      isRoleAbove(user.role, "match_organizer")
    );
  }

  public async createDraftGame(user: User, settings: CreateDraftGameSettings) {
    if (!DraftGameService.DRAFTABLE_TYPES.includes(settings.type)) {
      throw new DraftGameError("Invalid draft game type");
    }

    if (settings.mode === "Teams") {
      await this.verifyTeamAccess(user, [
        settings.team_1_id,
        settings.team_2_id,
      ]);
    }

    // Organizers can open a lobby they manage but do not play in; everyone else
    // is always seeded as the first accepted player.
    const hostJoins =
      settings.host_joins === false && isRoleAbove(user.role, "match_organizer")
        ? false
        : true;

    const captainSelection =
      !hostJoins && settings.captain_selection === "HostAndNext"
        ? "TopEloTwo"
        : settings.captain_selection;

    const draftGameId = await this.playerLock(user.steam_id, async () => {
      if (hostJoins) {
        await this.verifyPlayerEligible(user.steam_id);

        const existing = await this.getPlayerActiveDraftGame(user.steam_id);
        if (existing) {
          throw new DraftGameError("You are already in a draft game");
        }
      }

      const capacity = ExpectedPlayers[settings.type];
      const elo = hostJoins
        ? await this.getPlayerElo(user.steam_id, settings.type)
        : null;

      const matchOptionsId = await this.createMatchOptions(user, settings);

      const bothTeams =
        settings.mode === "Teams" &&
        !!settings.team_1_id &&
        !!settings.team_2_id;
      const access = (
        bothTeams ? "Private" : settings.access || "Open"
      ) as e_lobby_access_enum;

      let inserted;
      try {
        const { insert_draft_games_one } = await this.hasura.mutation({
          insert_draft_games_one: {
            __args: {
              object: {
                host_steam_id: user.steam_id,
                type: settings.type,
                mode: settings.mode || "Captains",
                access,
                match_options_id: matchOptionsId,
                team_1_id: settings.team_1_id,
                team_2_id: settings.team_2_id,
                inner_squad: settings.inner_squad || false,
                require_approval: settings.require_approval || false,
                regions: settings.regions || [],
                map_pool_id: settings.map_pool_id,
                captain_selection: captainSelection,
                draft_order: settings.draft_order,
                min_elo: settings.min_elo,
                max_elo: settings.max_elo,
                capacity,
                ...(hostJoins
                  ? {
                      players: {
                        data: [
                          {
                            steam_id: user.steam_id,
                            elo_snapshot: elo,
                            status: "Accepted",
                          },
                        ],
                      },
                    }
                  : {}),
              },
            },
            id: true,
          },
        });
        inserted = insert_draft_games_one;
      } catch (error) {
        if (matchOptionsId) {
          await this.hasura.mutation({
            delete_match_options_by_pk: {
              __args: { id: matchOptionsId },
              __typename: true,
            },
          });
        }
        throw error;
      }

      if (hostJoins) {
        await this.clearOtherRequests(user.steam_id, inserted.id);
      }

      if (settings.mode === "Teams") {
        await this.seedDraftPlayers(
          inserted.id,
          user.steam_id,
          settings.roster || [],
          settings.type,
        );
      } else if (hostJoins) {
        await this.addLobbyMembersToDraft(
          user.steam_id,
          inserted.id,
          settings,
          capacity,
        );
      }

      return inserted.id;
    });

    return draftGameId;
  }

  public async onDraftDeleted(draftGameId: string) {
    await this.draftService.removeAllPickTimers(draftGameId);
  }

  public async joinDraftGame(
    user: User,
    draftGameId: string,
    inviteCode?: string,
  ) {
    return this.draftLock(draftGameId, async () => {
      const draftGame = await this.getDraftGame(draftGameId);

      if (!draftGame) {
        throw new DraftGameError("Draft game not found");
      }

      const terminal =
        !!draftGame.match_id ||
        ["CreatingMatch", "Completed", "Canceled"].includes(draftGame.status);
      if (terminal) {
        throw new DraftGameError(
          "This draft game is no longer accepting players",
        );
      }

      if (
        draftGame.players.find((player) => player.steam_id === user.steam_id)
      ) {
        return;
      }

      await this.verifyJoinAccess(user, draftGame, inviteCode);

      const requiresApproval =
        draftGame.require_approval && user.steam_id !== draftGame.host_steam_id;

      const started = draftGame.status !== "Open";
      const acceptedCount = this.acceptedPlayers(draftGame).length;
      const isFull = acceptedCount >= draftGame.capacity;

      const status =
        !started && requiresApproval
          ? "Requested"
          : started || isFull
            ? "Waitlist"
            : "Accepted";

      await this.playerLock(user.steam_id, async () => {
        await this.verifyPlayerEligible(user.steam_id);

        if (status !== "Requested") {
          const existing = await this.getPlayerActiveDraftGame(user.steam_id);
          if (existing) {
            throw new DraftGameError("You are already in a draft game");
          }
        }

        const elo = await this.getPlayerElo(user.steam_id, draftGame.type);

        if (draftGame.min_elo && elo < draftGame.min_elo) {
          throw new DraftGameError("Your rank is too low for this draft game");
        }

        if (draftGame.max_elo && elo > draftGame.max_elo) {
          throw new DraftGameError("Your rank is too high for this draft game");
        }

        await this.hasura.mutation({
          insert_draft_game_players_one: {
            __args: {
              object: {
                draft_game_id: draftGameId,
                steam_id: user.steam_id,
                elo_snapshot: elo,
                status,
              },
            },
            __typename: true,
          },
        });

        if (status === "Accepted") {
          await this.clearOtherRequests(user.steam_id, draftGameId);
        }
      });
    });
  }

  public async previewDraftGame(
    user: User,
    draftGameId: string,
    inviteCode?: string,
  ) {
    const draftGame = await this.getDraftGame(draftGameId);

    if (!draftGame) {
      throw new DraftGameError("Draft game not found");
    }

    await this.verifyJoinAccess(user, draftGame, inviteCode);

    const host = draftGame.players.find(
      (player) => player.steam_id === draftGame.host_steam_id,
    );

    return {
      id: draftGame.id,
      type: draftGame.type,
      mode: draftGame.mode,
      access: draftGame.access,
      status: draftGame.status,
      capacity: draftGame.capacity,
      require_approval: draftGame.require_approval,
      host_steam_id: draftGame.host_steam_id,
      host_name: host?.name ?? null,
      host_avatar_url: host?.avatar_url ?? null,
      accepted_count: this.acceptedPlayers(draftGame).length,
      players: draftGame.players.map((player) => ({
        steam_id: player.steam_id,
        name: player.name,
        avatar_url: player.avatar_url ?? null,
        status: player.status ?? null,
      })),
    };
  }

  private async verifyJoinAccess(
    user: User,
    draftGame: DraftGame,
    inviteCode?: string,
  ) {
    if (this.isOrganizerOrHost(user, draftGame)) {
      return;
    }
    if (draftGame.players.find((player) => player.steam_id === user.steam_id)) {
      return;
    }

    switch (draftGame.access) {
      case "Open":
        return;
      case "Invite":
        if (inviteCode !== draftGame.invite_code) {
          throw new DraftGameError("A valid invite is required to join");
        }
        return;
      case "Friends": {
        const memberIds = draftGame.players
          .map((player) => player.steam_id)
          .concat(draftGame.host_steam_id);

        const { my_friends } = await this.hasura.query({
          my_friends: {
            __args: {
              where: {
                steam_id: { _eq: user.steam_id },
                friend_steam_id: { _in: memberIds },
                status: { _eq: "Accepted" },
              },
            },
            friend_steam_id: true,
          },
        });

        if (!my_friends || my_friends.length === 0) {
          throw new DraftGameError("This lobby is friends-only");
        }
        return;
      }
      case "Private":
        throw new DraftGameError("This lobby is private");
      default:
        throw new DraftGameError("This lobby cannot be joined");
    }
  }

  private async addLobbyMembersToDraft(
    hostSteamId: string,
    draftGameId: string,
    settings: CreateDraftGameSettings,
    capacity: number,
  ) {
    if (settings.mode === "Teams") {
      return;
    }

    const members = await this.getPartyMembers(hostSteamId);
    const others = members.filter((steamId) => steamId !== hostSteamId);

    if (others.length === 0) {
      return;
    }

    const candidates = await this.getDraftCandidates(others, settings.type);

    const perTeam = capacity / 2;
    const keepTogether =
      !!settings.keep_lobby_together &&
      members.length <= perTeam &&
      ["Host", "Pug"].includes(settings.mode || "");

    if (keepTogether) {
      await this.hasura.mutation({
        update_draft_game_players_by_pk: {
          __args: {
            pk_columns: { draft_game_id: draftGameId, steam_id: hostSteamId },
            _set: { lineup: 1, pick_order: 1 },
          },
          __typename: true,
        },
      });
    }

    let accepted = 1;
    let teamCount = 1;

    for (const steamId of others) {
      if (accepted >= capacity) {
        break;
      }

      const candidate = candidates.get(steamId);
      if (!candidate || !candidate.eligible) {
        continue;
      }

      const elo = candidate.elo;
      if (settings.min_elo && elo < settings.min_elo) {
        continue;
      }
      if (settings.max_elo && elo > settings.max_elo) {
        continue;
      }

      const nextPickOrder = teamCount + 1;

      const inserted = await this.playerLock(steamId, async () => {
        const elsewhere = await this.getPlayerActiveDraftGame(steamId);
        if (elsewhere) {
          return false;
        }

        await this.hasura.mutation({
          insert_draft_game_players_one: {
            __args: {
              object: {
                draft_game_id: draftGameId,
                steam_id: steamId,
                elo_snapshot: elo,
                status: "Accepted",
                lineup: keepTogether ? 1 : null,
                pick_order: keepTogether ? nextPickOrder : null,
              },
            },
            __typename: true,
          },
        });

        await this.clearOtherRequests(steamId, draftGameId);

        return true;
      });

      if (!inserted) {
        continue;
      }

      teamCount++;
      accepted++;
    }
  }

  private async seedDraftPlayers(
    draftGameId: string,
    hostSteamId: string,
    roster: Array<DraftRosterEntry>,
    type: e_match_types_enum,
  ) {
    const pickOrders: Record<number, number> = { 1: 0, 2: 0 };
    const seen = new Set<string>();

    for (const entry of roster) {
      const steamId = String(entry.steam_id);
      if (seen.has(steamId)) {
        continue;
      }
      seen.add(steamId);
      const starting =
        entry.lineup === 1 || entry.lineup === 2 ? entry.lineup : null;
      const status = starting === null ? "Waitlist" : "Accepted";
      const pickOrder = starting === null ? null : ++pickOrders[starting];
      // A benched roster member is a backup for their own side, not a floating
      // spare: keep the side so the room can list them under that team.
      const side = entry.side === 1 || entry.side === 2 ? entry.side : null;
      const lineup = starting ?? side;
      const elo = await this.getPlayerElo(steamId, type);

      if (steamId === hostSteamId) {
        await this.hasura.mutation({
          update_draft_game_players_by_pk: {
            __args: {
              pk_columns: { draft_game_id: draftGameId, steam_id: steamId },
              _set: { status, lineup, pick_order: pickOrder },
            },
            __typename: true,
          },
        });
        continue;
      }

      await this.playerLock(steamId, async () => {
        if (status === "Accepted") {
          const elsewhere = await this.getPlayerActiveDraftGame(steamId);
          if (elsewhere && elsewhere !== draftGameId) {
            return;
          }
        }

        await this.hasura.mutation({
          insert_draft_game_players_one: {
            __args: {
              object: {
                draft_game_id: draftGameId,
                steam_id: steamId,
                elo_snapshot: elo,
                status,
                lineup,
                pick_order: pickOrder,
              },
              on_conflict: {
                constraint: "draft_game_players_pkey",
                update_columns: ["status", "lineup", "pick_order"],
              },
            },
            __typename: true,
          },
        });

        if (status === "Accepted") {
          await this.clearOtherRequests(steamId, draftGameId);
        }
      });
    }
  }

  private async reseedDraftPlayers(
    draftGameId: string,
    hostSteamId: string,
    roster: Array<DraftRosterEntry>,
    type: e_match_types_enum,
  ) {
    await this.hasura.mutation({
      delete_draft_game_players: {
        __args: {
          where: {
            draft_game_id: { _eq: draftGameId },
            steam_id: { _neq: hostSteamId },
          },
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      update_draft_game_players_by_pk: {
        __args: {
          pk_columns: { draft_game_id: draftGameId, steam_id: hostSteamId },
          _set: {
            status: "Accepted",
            lineup: null,
            pick_order: null,
            is_captain: false,
          },
        },
        __typename: true,
      },
    });

    await this.seedDraftPlayers(draftGameId, hostSteamId, roster, type);
  }

  private async getDraftCandidates(
    steamIds: Array<string>,
    type: e_match_types_enum,
  ): Promise<Map<string, { eligible: boolean; elo: number }>> {
    const candidates = new Map<string, { eligible: boolean; elo: number }>();

    if (steamIds.length === 0) {
      return candidates;
    }

    const { players } = await this.hasura.query({
      players: {
        __args: { where: { steam_id: { _in: steamIds } } },
        steam_id: true,
        is_banned: true,
        matchmaking_cooldown: true,
        is_in_another_match: true,
        elo: true,
      },
    });

    for (const player of players) {
      const eligible =
        !player.is_banned &&
        !player.matchmaking_cooldown &&
        !player.is_in_another_match;

      const eloMap = player.elo as Record<string, unknown> | null | undefined;
      const raw = eloMap ? eloMap[type.toLowerCase()] : undefined;
      const parsed = raw != null ? Number(raw) : NaN;
      const elo = Number.isFinite(parsed)
        ? parsed
        : DraftGameService.DEFAULT_ELO;

      candidates.set(player.steam_id, { eligible, elo });
    }

    return candidates;
  }

  private async getPartyMembers(steamId: string): Promise<string[]> {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        current_lobby_id: true,
      },
    });

    const lobbyId = players_by_pk?.current_lobby_id;
    if (!lobbyId) {
      return [steamId];
    }

    const { lobbies_by_pk } = await this.hasura.query({
      lobbies_by_pk: {
        __args: { id: lobbyId },
        players: {
          __args: { where: { status: { _eq: "Accepted" } } },
          steam_id: true,
        },
      },
    });

    const members = (lobbies_by_pk?.players || []).map(
      (player) => player.steam_id,
    );

    if (!members.includes(steamId)) {
      members.unshift(steamId);
    }

    return members;
  }

  public async joinDraftGameAsParty(
    user: User,
    draftGameId: string,
    inviteCode?: string,
  ) {
    return this.draftLock(draftGameId, async () => {
      const draftGame = await this.getDraftGame(draftGameId);

      if (!draftGame || draftGame.status !== "Open" || draftGame.match_id) {
        throw new DraftGameError("This lobby is not open");
      }

      await this.verifyJoinAccess(user, draftGame, inviteCode);

      const members = await this.getPartyMembers(user.steam_id);
      const requiresApproval =
        draftGame.require_approval && user.steam_id !== draftGame.host_steam_id;

      let acceptedCount = this.acceptedPlayers(draftGame).length;
      const joined: string[] = [];

      for (const steamId of members) {
        if (draftGame.players.find((player) => player.steam_id === steamId)) {
          continue;
        }

        const status = requiresApproval
          ? "Requested"
          : acceptedCount < draftGame.capacity
            ? "Accepted"
            : "Waitlist";

        const inserted = await this.playerLock(steamId, async () => {
          const elsewhere = await this.getPlayerActiveDraftGame(steamId);
          if (elsewhere && elsewhere !== draftGameId) {
            return false;
          }

          const elo = await this.getPlayerElo(steamId, draftGame.type);
          if (draftGame.min_elo && elo < draftGame.min_elo) {
            return false;
          }
          if (draftGame.max_elo && elo > draftGame.max_elo) {
            return false;
          }

          await this.hasura.mutation({
            insert_draft_game_players_one: {
              __args: {
                object: {
                  draft_game_id: draftGameId,
                  steam_id: steamId,
                  elo_snapshot: elo,
                  status,
                },
              },
              __typename: true,
            },
          });

          if (status === "Accepted") {
            await this.clearOtherRequests(steamId, draftGameId);
          }

          return true;
        });

        if (!inserted) {
          continue;
        }

        if (status === "Accepted") {
          acceptedCount++;
        }

        joined.push(steamId);
      }

      if (joined.length === 0) {
        throw new DraftGameError("No one in your party could join this lobby");
      }
    });
  }

  // Whether `role` may add players straight to the lineup. Below the configured
  // threshold (public.draft_add_without_invite) an add becomes an invite the
  // target must accept. No setting => anyone who can add, adds directly.
  private async canAddWithoutInvite(
    role: e_player_roles_enum,
  ): Promise<boolean> {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: "public.draft_add_without_invite" },
        value: true,
      },
    });

    const threshold = settings_by_pk?.value;
    if (!threshold) {
      return true;
    }

    return isRoleAbove(role, threshold as e_player_roles_enum);
  }

  public async addDraftPlayer(
    user: User,
    draftGameId: string,
    steamId: string,
  ) {
    return this.draftLock(draftGameId, async () => {
      const draftGame = await this.getDraftGame(draftGameId);

      if (!draftGame) {
        throw new DraftGameError("Draft game not found");
      }

      if (!this.isOrganizerOrHost(user, draftGame)) {
        throw new DraftGameError(
          "Only the host or an organizer can add players",
        );
      }

      const terminal =
        !!draftGame.match_id ||
        ["CreatingMatch", "Completed", "Canceled"].includes(draftGame.status);
      if (terminal) {
        throw new DraftGameError(
          "This draft game is no longer accepting players",
        );
      }

      if (draftGame.players.find((player) => player.steam_id === steamId)) {
        return;
      }

      const addWithoutInvite = await this.canAddWithoutInvite(user.role);

      await this.playerLock(steamId, async () => {
        await this.verifyPlayerEligible(steamId);

        const elo = await this.getPlayerElo(steamId, draftGame.type);

        if (draftGame.min_elo && elo < draftGame.min_elo) {
          throw new DraftGameError("Player's rank is too low for this lobby");
        }
        if (draftGame.max_elo && elo > draftGame.max_elo) {
          throw new DraftGameError("Player's rank is too high for this lobby");
        }

        let status: string;
        if (!addWithoutInvite) {
          status = "Invited";
        } else {
          const elsewhere = await this.getPlayerActiveDraftGame(steamId);
          if (elsewhere && elsewhere !== draftGameId) {
            throw new DraftGameError("Player is already in a draft game");
          }
          const started = draftGame.status !== "Open";
          const isFull =
            this.acceptedPlayers(draftGame).length >= draftGame.capacity;
          status = started || isFull ? "Waitlist" : "Accepted";
        }

        await this.hasura.mutation({
          insert_draft_game_players_one: {
            __args: {
              object: {
                draft_game_id: draftGameId,
                steam_id: steamId,
                elo_snapshot: elo,
                status: status as e_draft_game_player_status_enum,
              },
            },
            __typename: true,
          },
        });

        if (status === "Accepted") {
          await this.clearOtherRequests(steamId, draftGameId);
        }
      });
    });
  }

  public async respondDraftInvite(
    user: User,
    draftGameId: string,
    accept: boolean,
  ) {
    return this.draftLock(draftGameId, async () => {
      const draftGame = await this.getDraftGame(draftGameId);

      if (!draftGame) {
        throw new DraftGameError("Draft game not found");
      }

      const membership = draftGame.players.find(
        (player) => player.steam_id === user.steam_id,
      );
      if (!membership || membership.status !== "Invited") {
        throw new DraftGameError("You do not have a pending invite");
      }

      if (!accept) {
        await this.hasura.mutation({
          delete_draft_game_players_by_pk: {
            __args: { draft_game_id: draftGameId, steam_id: user.steam_id },
            __typename: true,
          },
        });
        return;
      }

      const terminal =
        !!draftGame.match_id ||
        ["CreatingMatch", "Completed", "Canceled"].includes(draftGame.status);
      if (terminal) {
        throw new DraftGameError(
          "This draft game is no longer accepting players",
        );
      }

      await this.playerLock(user.steam_id, async () => {
        await this.verifyPlayerEligible(user.steam_id);

        const elsewhere = await this.getPlayerActiveDraftGame(user.steam_id);
        if (elsewhere && elsewhere !== draftGameId) {
          throw new DraftGameError("You are already in a draft game");
        }

        const started = draftGame.status !== "Open";
        const isFull =
          this.acceptedPlayers(draftGame).length >= draftGame.capacity;
        const status = started || isFull ? "Waitlist" : "Accepted";

        await this.hasura.mutation({
          update_draft_game_players_by_pk: {
            __args: {
              pk_columns: {
                draft_game_id: draftGameId,
                steam_id: user.steam_id,
              },
              _set: { status },
            },
            __typename: true,
          },
        });

        if (status === "Accepted") {
          await this.clearOtherRequests(user.steam_id, draftGameId);
        }
      });
    });
  }

  public acceptedPlayers(draftGame: DraftGame) {
    return draftGame.players.filter((player) => player.status === "Accepted");
  }

  private async resolveMapPoolId(
    settings: Partial<CreateDraftGameSettings>,
    draftGame: DraftGame,
  ): Promise<string | null> {
    if (settings.map_pool_id) {
      return settings.map_pool_id;
    }

    const customMaps = (settings.options as Record<string, any>)?.map_pool?.data
      ?.maps?.data as Array<any> | undefined;

    if (!customMaps?.length) {
      return null;
    }

    const mapIds = customMaps.filter((map) => map?.id).map((map) => map.id);

    if (draftGame.match_options_id) {
      const { match_options_by_pk } = await this.hasura.query({
        match_options_by_pk: {
          __args: { id: draftGame.match_options_id },
          map_pool: {
            id: true,
            type: true,
          },
        },
      });

      const existing = match_options_by_pk?.map_pool;
      if (existing?.type === "Custom") {
        await this.hasura.mutation({
          delete__map_pool: {
            __args: { where: { map_pool_id: { _eq: existing.id } } },
            affected_rows: true,
          },
        });
        await this.hasura.mutation({
          insert__map_pool: {
            __args: {
              objects: mapIds.map((map_id) => ({
                map_pool_id: existing.id,
                map_id,
              })),
            },
            affected_rows: true,
          },
        });
        return existing.id;
      }
    }

    const { insert_map_pools_one } = await this.hasura.mutation({
      insert_map_pools_one: {
        __args: {
          object: {
            type: "Custom",
            maps: {
              data: mapIds.map((id) => ({ id })),
            },
          },
        },
        id: true,
      },
    });

    return insert_map_pools_one.id;
  }

  private matchOptionScalars(
    user: User,
    options: Record<string, unknown>,
  ): Record<string, unknown> {
    const source = options as Record<string, any>;

    const object: Record<string, unknown> = {
      mr: source.mr,
      best_of: source.best_of,
      knife_round: source.knife_round,
      default_models: source.default_models,
      overtime: source.overtime,
      map_veto: source.map_veto,
      coaches: source.coaches,
      region_veto: source.region_veto,
      regions: Array.isArray(source.regions) ? source.regions : [],
      number_of_substitutes: source.number_of_substitutes,
      timeout_setting: source.timeout_setting,
      ready_setting: source.ready_setting,
      tech_timeout_setting: source.tech_timeout_setting,
      tv_delay: source.tv_delay,
    };

    if (source.map_pool_id) {
      object.map_pool_id = source.map_pool_id;
    }

    if (isRoleAbove(user.role, "tournament_organizer")) {
      object.auto_cancellation = source.auto_cancellation;
      object.match_mode = source.match_mode;
      object.auto_cancel_duration = source.auto_cancel_duration ?? null;
      object.live_match_timeout = source.live_match_timeout ?? null;
    }

    return object;
  }

  private async createMatchOptions(
    user: User,
    settings: CreateDraftGameSettings,
  ): Promise<string | undefined> {
    if (!settings.options) {
      return undefined;
    }

    const source = settings.options as Record<string, any>;

    const object: Record<string, unknown> = {
      ...this.matchOptionScalars(user, source),
      type: settings.type,
    };

    if (!source.map_pool_id && source.map_pool?.data?.maps?.data) {
      object.map_pool = {
        data: {
          type: "Custom",
          maps: {
            data: (source.map_pool.data.maps.data as Array<any>)
              .filter((map) => map?.id)
              .map((map) => ({ id: map.id })),
          },
        },
      };
    }

    const { insert_match_options_one } = await this.hasura.mutation({
      insert_match_options_one: {
        __args: {
          object,
        },
        id: true,
      },
    });

    return insert_match_options_one.id;
  }

  private async verifyTeamAccess(
    user: User,
    teamIds: Array<string | undefined>,
  ) {
    const ids = teamIds.filter((id): id is string => !!id);

    if (ids.length === 0) {
      return;
    }

    if (ids.length === 2 && ids[0] === ids[1]) {
      throw new DraftGameError("Team 1 and Team 2 cannot be the same");
    }

    if (isRoleAbove(user.role, "match_organizer")) {
      return;
    }

    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _in: ids },
            player_steam_id: { _eq: user.steam_id },
          },
        },
        team_id: true,
      },
    });

    const owned = new Set(team_roster.map((row) => row.team_id));

    for (const id of ids) {
      if (!owned.has(id)) {
        throw new DraftGameError("You are not a member of that team");
      }
    }
  }

  public async updateDraftSettings(
    user: User,
    draftGameId: string,
    settings: Partial<CreateDraftGameSettings>,
  ) {
    return this.draftLock(draftGameId, async () => {
      const draftGame = await this.getDraftGame(draftGameId);

      if (!draftGame) {
        throw new DraftGameError("Draft game not found");
      }

      if (!this.isOrganizerOrHost(user, draftGame)) {
        throw new DraftGameError(
          "Only the host or an organizer can edit settings",
        );
      }

      if (draftGame.status !== "Open") {
        throw new DraftGameError(
          "Settings can only be changed before the draft",
        );
      }

      const nextMode = (settings.mode ||
        draftGame.mode) as e_draft_game_mode_enum;

      if (nextMode === "Teams") {
        await this.verifyTeamAccess(user, [
          settings.team_1_id,
          settings.team_2_id,
        ]);
      }

      let capacity = draftGame.capacity;
      if (settings.type && settings.type !== draftGame.type) {
        if (!DraftGameService.DRAFTABLE_TYPES.includes(settings.type)) {
          throw new DraftGameError("Invalid draft game type");
        }
        capacity = ExpectedPlayers[settings.type];
      }

      const _set: Record<string, unknown> = {};
      if (settings.type) {
        _set.type = settings.type;
        _set.capacity = capacity;
      }
      if (settings.regions) {
        _set.regions = settings.regions;
      }
      if (settings.mode) {
        _set.mode = settings.mode;
      }
      if (settings.access) {
        _set.access = settings.access;
      }
      if (settings.captain_selection) {
        _set.captain_selection = settings.captain_selection;
      }
      if (settings.draft_order) {
        _set.draft_order = settings.draft_order;
      }
      if (settings.require_approval !== undefined) {
        _set.require_approval = settings.require_approval;
      }
      const mapPoolId = await this.resolveMapPoolId(settings, draftGame);

      const nextTeam1 = nextMode === "Teams" ? settings.team_1_id : undefined;
      const nextTeam2 = nextMode === "Teams" ? settings.team_2_id : undefined;
      const nextInnerSquad =
        nextMode === "Teams" ? !!settings.inner_squad : false;

      _set.team_1_id = nextTeam1 ?? null;
      _set.team_2_id = nextTeam2 ?? null;
      _set.inner_squad = nextInnerSquad;
      _set.map_pool_id = mapPoolId;
      _set.min_elo = settings.min_elo ?? null;
      _set.max_elo = settings.max_elo ?? null;

      if (nextMode === "Teams" && nextTeam1 && nextTeam2) {
        _set.access = "Private";
      }

      await this.hasura.mutation({
        update_draft_games_by_pk: {
          __args: {
            pk_columns: { id: draftGameId },
            _set,
          },
          __typename: true,
        },
      });

      await this.reconcileAfterSettingsChange(draftGame, nextMode, capacity);

      if (nextMode === "Teams" && settings.roster) {
        await this.reseedDraftPlayers(
          draftGameId,
          draftGame.host_steam_id,
          settings.roster,
          settings.type || draftGame.type,
        );
      }

      if (settings.options && draftGame.match_options_id) {
        const optionSet = this.matchOptionScalars(user, settings.options);
        if (mapPoolId) {
          optionSet.map_pool_id = mapPoolId;
        }
        await this.hasura.mutation({
          update_match_options_by_pk: {
            __args: {
              pk_columns: { id: draftGame.match_options_id },
              _set: optionSet,
            },
            __typename: true,
          },
        });
      }
    });
  }

  private async reconcileAfterSettingsChange(
    previous: DraftGame,
    nextMode: e_draft_game_mode_enum,
    capacity: number,
  ) {
    const perTeam = capacity / 2;

    if (nextMode === "Captains") {
      await this.clearAssignedTeams(previous.id);
    } else if (capacity !== previous.capacity) {
      const overfilled = [1, 2].some(
        (lineup) =>
          previous.players.filter((player) => player.lineup === lineup).length >
          perTeam,
      );
      if (overfilled) {
        await this.clearAssignedTeams(previous.id);
      }
    }

    if (capacity < previous.capacity) {
      await this.demoteOverflowToWaitlist(previous, capacity);
    }
  }

  private async clearAssignedTeams(draftGameId: string) {
    await this.hasura.mutation({
      update_draft_game_players: {
        __args: {
          where: { draft_game_id: { _eq: draftGameId } },
          _set: { lineup: null, pick_order: null, is_captain: false },
        },
        __typename: true,
      },
    });
  }

  private async demoteOverflowToWaitlist(
    draftGame: DraftGame,
    capacity: number,
  ) {
    if (this.acceptedPlayers(draftGame).length <= capacity) {
      return;
    }

    const { draft_game_players } = await this.hasura.query({
      draft_game_players: {
        __args: {
          where: {
            draft_game_id: { _eq: draftGame.id },
            status: { _eq: "Accepted" },
            steam_id: { _neq: draftGame.host_steam_id },
          },
          order_by: [{ joined_at: "asc" }],
        },
        steam_id: true,
      },
    });

    const overflow = draft_game_players.slice(capacity - 1);

    for (const player of overflow) {
      await this.hasura.mutation({
        update_draft_game_players_by_pk: {
          __args: {
            pk_columns: {
              draft_game_id: draftGame.id,
              steam_id: player.steam_id,
            },
            _set: {
              status: "Waitlist",
              lineup: null,
              pick_order: null,
              is_captain: false,
            },
          },
          __typename: true,
        },
      });
    }
  }

  public async getDraftGame(
    draftGameId: string,
  ): Promise<DraftGame | undefined> {
    const { draft_games_by_pk } = await this.hasura.query({
      draft_games_by_pk: {
        __args: {
          id: draftGameId,
        },
        id: true,
        host_steam_id: true,
        status: true,
        type: true,
        mode: true,
        access: true,
        invite_code: true,
        regions: true,
        map_pool_id: true,
        match_options_id: true,
        team_1_id: true,
        team_2_id: true,
        inner_squad: true,
        captain_selection: true,
        draft_order: true,
        min_elo: true,
        max_elo: true,
        capacity: true,
        require_approval: true,
        match_id: true,
        current_pick_lineup: true,
        pick_deadline: true,
        created_at: true,
        players: {
          steam_id: true,
          status: true,
          elo_snapshot: true,
          is_captain: true,
          lineup: true,
          pick_order: true,
          joined_at: true,
          player: {
            name: true,
            avatar_url: true,
          },
        },
      },
    });

    if (!draft_games_by_pk) {
      return undefined;
    }

    return {
      id: draft_games_by_pk.id,
      host_steam_id: draft_games_by_pk.host_steam_id,
      status: draft_games_by_pk.status,
      type: draft_games_by_pk.type,
      mode: draft_games_by_pk.mode as e_draft_game_mode_enum,
      access: draft_games_by_pk.access,
      invite_code: draft_games_by_pk.invite_code,
      regions: draft_games_by_pk.regions,
      map_pool_id: draft_games_by_pk.map_pool_id,
      match_options_id: draft_games_by_pk.match_options_id,
      team_1_id: draft_games_by_pk.team_1_id,
      team_2_id: draft_games_by_pk.team_2_id,
      inner_squad: draft_games_by_pk.inner_squad,
      captain_selection: draft_games_by_pk.captain_selection,
      draft_order: draft_games_by_pk.draft_order,
      min_elo: draft_games_by_pk.min_elo,
      max_elo: draft_games_by_pk.max_elo,
      capacity: draft_games_by_pk.capacity,
      require_approval: draft_games_by_pk.require_approval,
      match_id: draft_games_by_pk.match_id,
      current_pick_lineup: draft_games_by_pk.current_pick_lineup,
      pick_deadline: draft_games_by_pk.pick_deadline,
      created_at: draft_games_by_pk.created_at,
      players: draft_games_by_pk.players.map((player) => {
        return {
          steam_id: player.steam_id,
          name: player.player.name,
          avatar_url: player.player.avatar_url,
          elo_snapshot: player.elo_snapshot,
          is_captain: player.is_captain,
          status: player.status,
          lineup: player.lineup,
          pick_order: player.pick_order,
          joined_at: player.joined_at,
        };
      }),
    };
  }

  private async getPlayerActiveDraftGame(
    steamId: string,
  ): Promise<string | undefined> {
    const { draft_game_players } = await this.hasura.query({
      draft_game_players: {
        __args: {
          where: {
            steam_id: { _eq: steamId },
            status: { _eq: "Accepted" },
            draft_game: {
              status: {
                _nin: ["Completed", "Canceled"],
              },
            },
          },
          order_by: [{ joined_at: "desc" }],
          limit: 1,
        },
        draft_game_id: true,
      },
    });

    return draft_game_players.at(0)?.draft_game_id;
  }

  private async clearOtherRequests(steamId: string, keepDraftGameId: string) {
    const { draft_game_players } = await this.hasura.query({
      draft_game_players: {
        __args: {
          where: {
            steam_id: { _eq: steamId },
            draft_game_id: { _neq: keepDraftGameId },
            draft_game: {
              status: { _nin: ["Completed", "Canceled"] },
              host_steam_id: { _neq: steamId },
            },
          },
        },
        draft_game_id: true,
      },
    });

    const affected = Array.from(
      new Set(draft_game_players.map((row) => row.draft_game_id)),
    );

    if (affected.length === 0) {
      return;
    }

    await this.hasura.mutation({
      delete_draft_game_players: {
        __args: {
          where: {
            steam_id: { _eq: steamId },
            draft_game_id: { _in: affected },
          },
        },
        __typename: true,
      },
    });
  }

  private async verifyPlayerEligible(steamId: string) {
    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
        is_banned: true,
        matchmaking_cooldown: true,
        is_in_another_match: true,
      },
    });

    if (!player) {
      throw new DraftGameError("Player not found");
    }

    if (player.is_in_another_match) {
      throw new DraftGameError(`${player.name} is already in a match`);
    }

    if (player.matchmaking_cooldown) {
      throw new DraftGameError(`${player.name} is in matchmaking cooldown`);
    }

    if (player.is_banned) {
      throw new DraftGameError(`${player.name} is banned`);
    }
  }

  public async getPlayerElo(
    steamId: string,
    type: e_match_types_enum,
  ): Promise<number> {
    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        elo: true,
      },
    });

    const elo = player?.elo as Record<string, unknown> | null | undefined;
    const value = elo ? elo[type.toLowerCase()] : undefined;
    const parsed = value != null ? Number(value) : NaN;

    if (!Number.isFinite(parsed)) {
      return DraftGameService.DEFAULT_ELO;
    }

    return parsed;
  }
}
