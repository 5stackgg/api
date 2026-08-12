import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { MediaMtxService } from "../mediamtx/mediamtx.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { User } from "../auth/types/User";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VoiceParticipant = {
  steamId: string;
  name: string | null;
  avatarUrl: string | null;
  speaking: boolean;
};

@Injectable()
export class VoiceService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly mediaMtx: MediaMtxService,
  ) {}

  // Mirrors the camera paths so both features are recognisable in a
  // `/v3/paths/list` dump and neither can collide with the other.
  public static pathForMember(lobbyId: string, steamId: string) {
    return `voice-${lobbyId}-${steamId}`;
  }

  // Read straight from the settings table rather than through SystemService,
  // which would drag its whole module graph (chat, k8s, s3, queues) into this
  // feature for the sake of one row.
  public async isEnabled() {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.VoiceChatEnabled],
    );

    return row?.value === "true";
  }

  // Voice is only ever offered to a lobby you are actually in, and only for
  // members who accepted — an invite that has not been taken up is not a seat
  // at the table.
  public async assertMember(lobbyId: string, user: User) {
    if (!(await this.isEnabled())) {
      throw new Error("voice chat is not enabled");
    }

    if (!UUID_PATTERN.test(lobbyId)) {
      throw new Error("not a member of this lobby");
    }

    const [row] = await this.postgres.query<Array<{ status: string }>>(
      `SELECT status FROM lobby_players WHERE lobby_id = $1 AND steam_id = $2`,
      [lobbyId, user.steam_id],
    );

    if (row?.status !== "Accepted") {
      throw new Error("not a member of this lobby");
    }
  }

  public async publish(lobbyId: string, user: User, sdp: string) {
    await this.assertMember(lobbyId, user);

    return this.mediaMtx.proxySdp(
      VoiceService.pathForMember(lobbyId, user.steam_id),
      "whip",
      sdp,
    );
  }

  public async subscribe(
    lobbyId: string,
    steamId: string,
    user: User,
    sdp: string,
  ) {
    await this.assertMember(lobbyId, user);

    if (steamId === user.steam_id) {
      throw new Error("cannot subscribe to your own microphone");
    }

    return this.mediaMtx.proxySdp(
      VoiceService.pathForMember(lobbyId, steamId),
      "whep",
      sdp,
    );
  }

  public async leave(lobbyId: string, user: User) {
    await this.assertMember(lobbyId, user);

    await this.mediaMtx.kickSessions(
      VoiceService.pathForMember(lobbyId, user.steam_id),
    );
  }

  // Everyone in the lobby, with a flag for who currently has a live mic, so the
  // panel can show the whole party rather than only the people already talking.
  public async participants(lobbyId: string, user: User) {
    await this.assertMember(lobbyId, user);

    const members = await this.postgres.query<
      Array<{ steam_id: string; name: string | null; avatar_url: string | null }>
    >(
      `SELECT lp.steam_id::text AS steam_id, p.name, p.avatar_url
       FROM lobby_players lp
       LEFT JOIN players p ON p.steam_id = lp.steam_id
       WHERE lp.lobby_id = $1 AND lp.status = 'Accepted'
       ORDER BY p.name`,
      [lobbyId],
    );

    const paths = await this.mediaMtx.listPaths();

    return members.map((member) => {
      const path = paths?.get(
        VoiceService.pathForMember(lobbyId, member.steam_id),
      );

      return {
        steamId: member.steam_id,
        name: member.name,
        avatarUrl: member.avatar_url,
        // Unknown when MediaMTX did not answer: better to show nobody talking
        // for one poll than to drop the whole party out of the list.
        speaking: path?.ready === true,
      } satisfies VoiceParticipant;
    });
  }
}
