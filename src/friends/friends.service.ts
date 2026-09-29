import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { PlayerBlocksService } from "../player-blocks/player-blocks.service";

@Injectable()
export class FriendsService {
  private readonly steamApiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly playerBlocks: PlayerBlocksService,
  ) {
    this.steamApiKey = this.config.get("steam.steamApiKey");
  }

  public async syncSteamFriends(user: User): Promise<boolean> {
    const response = await fetch(
      `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${this.steamApiKey}&steamid=${user.steam_id}`,
    );
    const { friendslist } = await response.json();
    const friends = friendslist?.friends.map((friend: { steamid: string }) => {
      return friend.steamid;
    });

    if (!friends || friends.length === 0) {
      return;
    }

    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            steam_id: {
              _in: friends,
            },
          },
        },
        steam_id: true,
      },
    });

    // One blocked friend would otherwise abort the loop for everyone after it.
    const unblocked = await this.playerBlocks.filterUnblocked(
      user.steam_id,
      players.map((player) => String(player.steam_id)),
    );

    for (const steamId of unblocked) {
      await this.hasura.mutation({
        insert_friends: {
          __args: {
            objects: [
              {
                player_steam_id: user.steam_id,
                other_player_steam_id: steamId,
                status: "Accepted",
              },
            ],
            on_conflict: {
              constraint: "friends_pkey",
              update_columns: ["status"],
            },
          },
          __typename: true,
        },
      });
    }

    return true;
  }
}
