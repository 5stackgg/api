import { Controller } from "@nestjs/common";
import { User } from "../auth/types/User";
import { HasuraAction } from "../hasura/hasura.controller";
import { FriendsService } from "./friends.service";

@Controller("friends")
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @HasuraAction()
  public async syncSteamFriends(data: {
    user: User;
  }): Promise<{ success: boolean }> {
    return {
      success: await this.friendsService.syncSteamFriends(data.user),
    };
  }
}
