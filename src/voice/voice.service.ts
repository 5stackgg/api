import { Injectable, Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { PostgresService } from "../postgres/postgres.service";
import { MediaMtxService } from "../mediamtx/mediamtx.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { User } from "../auth/types/User";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One message for "lobby" and "match lineup" alike: which of the two a channel
// id belongs to is not something a caller who failed the check should learn.
const NOT_A_MEMBER = "not a member of this voice channel";

// A client that dies mid-sentence never sends its "stopped" event, so the flag
// has to expire on its own. Long enough that a client refreshing it every few
// seconds never flickers, short enough that a crashed tab stops looking live.
const SPEAKING_TTL_SECONDS = 15;

// Membership is read on every speaking transition, which is far too often for a
// query. Joins and leaves drop the entry, so this only ever ages out a change
// nothing told us about.
const MEMBERS_TTL_SECONDS = 30;

// The last set of members MediaMTX reported as publishing, per channel. Only
// has to outlive the gap between monitor passes; it is rewritten on every one.
const PUBLISHING_TTL_SECONDS = 120;

// `voice-<uuid>-<steamid>`. Split on "-" would be ambiguous -- a uuid is full of
// them -- so the shape is matched whole.
const MEMBER_PATH_PATTERN =
  /^voice-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i;

export type VoiceParticipant = {
  steamId: string;
  name: string | null;
  avatarUrl: string | null;
  // In the call: MediaMTX has a live publisher on this member's path. The
  // client keeps that up for the whole session -- its gate mutes by gain, not
  // by dropping the track -- so this does not flicker with speech.
  connected: boolean;
  // Actually transmitting right now. Reported by the publisher's own gate,
  // which is the only thing that knows: MediaMTX sees a continuous stream
  // whether or not anyone is talking into it.
  speaking: boolean;
};

type VoiceMember = {
  steam_id: string;
  name: string | null;
  avatar_url: string | null;
};

@Injectable()
export class VoiceService {
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly mediaMtx: MediaMtxService,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();
  }

  // Mirrors the camera paths so both features are recognisable in a
  // `/v3/paths/list` dump and neither can collide with the other.
  public static pathForMember(lobbyId: string, steamId: string) {
    return `voice-${lobbyId}-${steamId}`;
  }

  private static speakingKey(channelId: string, steamId: string) {
    return `voice:speaking:${channelId}:${steamId}`;
  }

  private static membersKey(channelId: string) {
    return `voice:members:${channelId}`;
  }

  private static publishingKey(channelId: string) {
    return `voice:publishing:${channelId}`;
  }

  // The inverse of pathForMember, kept beside it so the two cannot drift.
  public static parseMemberPath(path: string) {
    const match = MEMBER_PATH_PATTERN.exec(path);

    return match ? { channelId: match[1], steamId: match[2] } : null;
  }

  // Read straight from the settings table rather than through SystemService,
  // which would drag its whole module graph (chat, k8s, s3, queues) into this
  // feature for the sake of one row. On by default — only an explicit "false"
  // disables it, matching require_login_for_live_streams.
  public async isEnabled() {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.VoiceChatEnabled],
    );

    return row?.value !== "false";
  }

  // A channel id is either a lobby id or a match lineup id. Both are uuids and
  // neither can collide, so match voice reuses the whole lobby transport rather
  // than duplicating it — the only thing that differs is who counts as a member.
  //
  // Match voice is deliberately scoped to one lineup, never the whole match: an
  // open channel between opposing teams is the same advantage the camera rules
  // exist to prevent.
  public async assertMember(channelId: string, user: User) {
    if (!(await this.isEnabled())) {
      throw new Error("voice chat is not enabled");
    }

    if (!UUID_PATTERN.test(channelId)) {
      throw new Error(NOT_A_MEMBER);
    }

    const [lobby] = await this.postgres.query<Array<{ status: string }>>(
      `SELECT status FROM lobby_players WHERE lobby_id = $1 AND steam_id = $2`,
      [channelId, user.steam_id],
    );

    if (lobby?.status === "Accepted") {
      return;
    }

    const [lineup] = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT true AS exists
       FROM match_lineup_players mlp
       INNER JOIN matches m
         ON m.lineup_1_id = mlp.match_lineup_id
         OR m.lineup_2_id = mlp.match_lineup_id
       WHERE mlp.match_lineup_id = $1
         AND mlp.steam_id = $2
         AND m.status NOT IN ('Finished', 'Canceled', 'Forfeit', 'Surrendered', 'Tie')
       LIMIT 1`,
      [channelId, user.steam_id],
    );

    if (lineup?.exists) {
      return;
    }

    throw new Error(NOT_A_MEMBER);
  }

  public async publish(lobbyId: string, user: User, sdp: string) {
    await this.assertMember(lobbyId, user);

    const answer = await this.mediaMtx.proxySdp(
      VoiceService.pathForMember(lobbyId, user.steam_id),
      "whip",
      sdp,
    );

    // Somebody joining is a change to the party, and it is the one moment a
    // stale membership cache would hide the new arrival from everyone else.
    await this.redis.del(VoiceService.membersKey(lobbyId));
    // Deferred: MediaMTX only reports the path as ready once the session is
    // actually up, which is after this answer gets back to the publisher.
    setTimeout(() => {
      void this.pushParticipants(lobbyId).catch((error: unknown) => {
        this.logger.warn(
          `failed to push voice participants for ${lobbyId}: ${
            (error as Error)?.message
          }`,
        );
      });
    }, 1000);

    return answer;
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

    await this.redis.del(VoiceService.speakingKey(lobbyId, user.steam_id));
    await this.pushParticipants(lobbyId);
  }

  // Everyone in the channel: who is in the call, and who is talking right now.
  public async participants(
    channelId: string,
    user: User,
  ): Promise<Array<VoiceParticipant>> {
    await this.assertMember(channelId, user);

    return this.buildParticipants(channelId);
  }

  // Membership, cached: this is read on every speaking transition, which is far
  // more often than a party changes shape.
  private async members(channelId: string): Promise<Array<VoiceMember>> {
    const cached = await this.redis.get(VoiceService.membersKey(channelId));

    if (cached) {
      try {
        return JSON.parse(cached) as Array<VoiceMember>;
      } catch {
        // Fall through and re-read; a corrupt cache is not worth an error.
      }
    }

    // Union rather than a branch on channel kind: a given id only ever matches
    // one of the two tables, so this stays a single round trip and the caller
    // never has to say which sort of channel it is asking about.
    const members = await this.postgres.query<Array<VoiceMember>>(
      `SELECT steam_id::text AS steam_id, name, avatar_url
       FROM (
         SELECT lp.steam_id, p.name, p.avatar_url
         FROM lobby_players lp
         LEFT JOIN players p ON p.steam_id = lp.steam_id
         WHERE lp.lobby_id = $1 AND lp.status = 'Accepted'

         UNION

         SELECT mlp.steam_id, p.name, p.avatar_url
         FROM match_lineup_players mlp
         LEFT JOIN players p ON p.steam_id = mlp.steam_id
         WHERE mlp.match_lineup_id = $1
       ) members
       ORDER BY name`,
      [channelId],
    );

    await this.redis.set(
      VoiceService.membersKey(channelId),
      JSON.stringify(members),
      "EX",
      MEMBERS_TTL_SECONDS,
    );

    return members;
  }

  private async buildParticipants(
    channelId: string,
    // Passed in by the monitor, which has just listed every path on the box
    // for all channels at once.
    known?: Map<string, { ready: boolean }> | null,
  ): Promise<Array<VoiceParticipant>> {
    const members = await this.members(channelId);

    if (members.length === 0) {
      return [];
    }

    const paths = known ?? (await this.mediaMtx.listPaths());

    const speaking = await this.redis.mget(
      members.map((member) =>
        VoiceService.speakingKey(channelId, member.steam_id),
      ),
    );

    return members.map((member, index) => {
      const path = paths?.get(
        VoiceService.pathForMember(channelId, member.steam_id),
      );

      const connected = path?.ready === true;

      return {
        steamId: member.steam_id,
        name: member.name,
        avatarUrl: member.avatar_url,
        // Unknown when MediaMTX did not answer: better to show nobody in the
        // call for one read than to drop the whole party out of the list.
        connected,
        // A flag left behind by a client that dropped would keep someone lit up
        // forever, so it only counts while they are still publishing.
        speaking: connected && speaking[index] !== null,
      } satisfies VoiceParticipant;
    });
  }

  // Voice activity, reported by the publisher's own gate -- MediaMTX sees a
  // continuous stream whether or not anyone is talking into it, so this is the
  // only place the truth exists.
  public async setSpeaking(channelId: string, user: User, speaking: boolean) {
    if (!UUID_PATTERN.test(channelId)) {
      throw new Error(NOT_A_MEMBER);
    }

    // Checked against the cached membership rather than through assertMember:
    // this runs on every gate transition, and two queries per person per
    // sentence is not a price a party of five should pay to light up an icon.
    // It is the same list assertMember reads, so it authorizes the same people.
    const members = await this.members(channelId);

    if (!members.some((member) => member.steam_id === user.steam_id)) {
      throw new Error(NOT_A_MEMBER);
    }

    const key = VoiceService.speakingKey(channelId, user.steam_id);

    // Repeats are keep-alives, not transitions: clients refresh while they hold
    // the gate open, and re-broadcasting each refresh would be pure noise.
    if (speaking) {
      const claimed = await this.redis.set(
        key,
        "1",
        "EX",
        SPEAKING_TTL_SECONDS,
        "NX",
      );

      if (claimed !== "OK") {
        await this.redis.expire(key, SPEAKING_TTL_SECONDS);
        return;
      }
    } else if ((await this.redis.del(key)) === 0) {
      return;
    }

    await this.push(
      channelId,
      "voice:speaking",
      { channelId, steamId: user.steam_id, speaking },
      members,
    );
  }

  // Sent whenever the shape of the call changes, so nobody has to poll to find
  // out that somebody joined or dropped.
  public async pushParticipants(
    channelId: string,
    known?: Map<string, { ready: boolean }> | null,
  ) {
    await this.push(channelId, "voice:participants", {
      channelId,
      participants: await this.buildParticipants(channelId, known),
    });
  }

  // Nobody tells us when a browser dies. The publish and leave endpoints cover
  // the polite cases; this covers the rest -- a closed laptop, a dropped uplink,
  // a killed tab -- by watching MediaMTX itself, the same way camera health is
  // watched. One list call covers every channel on the box.
  //
  // A channel that empties completely is not reported: with no publisher left
  // there is nobody still in the call to tell, and the member who dropped is
  // the one who would have been told.
  public async monitorChannels() {
    const paths = await this.mediaMtx.listPaths();

    // Fail open, like the camera monitor: an unreachable MediaMTX cannot be
    // told apart from an empty one, and emptying every call on our own outage
    // is far worse than being a pass late on a drop.
    if (!paths) {
      this.logger.warn("[voice] skipping monitor pass: mediamtx did not answer");
      return;
    }

    const publishing = new Map<string, Array<string>>();

    for (const [path, state] of paths) {
      if (!state?.ready) {
        continue;
      }

      const member = VoiceService.parseMemberPath(path);

      if (!member) {
        continue;
      }

      const channel = publishing.get(member.channelId) ?? [];
      channel.push(member.steamId);
      publishing.set(member.channelId, channel);
    }

    for (const [channelId, steamIds] of publishing) {
      const snapshot = steamIds.sort().join(",");
      const key = VoiceService.publishingKey(channelId);
      const previous = await this.redis.get(key);

      await this.redis.set(key, snapshot, "EX", PUBLISHING_TTL_SECONDS);

      // No previous snapshot means this pod has never seen the channel -- a
      // restart, or the channel just started. Seed it rather than announcing a
      // change nobody made.
      if (previous === null || previous === snapshot) {
        continue;
      }

      await this.pushParticipants(channelId, paths);
    }
  }

  // Addressed to the channel's members rather than broadcast: who is in a voice
  // channel, and who is talking in it, is not something every connected client
  // is entitled to know.
  private async push(
    channelId: string,
    event: string,
    data: unknown,
    // Passed in by callers that have just read it, so the hot path costs one
    // lookup rather than two.
    known?: Array<VoiceMember>,
  ) {
    const members = known ?? (await this.members(channelId));

    for (const member of members) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({ steamId: member.steam_id, event, data }),
      );
    }
  }
}
