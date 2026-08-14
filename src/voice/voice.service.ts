import { Injectable, Logger } from "@nestjs/common";
import { createHmac } from "crypto";
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

// A member's camera rides a path of its own rather than a second track on the
// one above. Turning a camera on or off would otherwise renegotiate the audio
// publish and force every other member to re-subscribe -- a drop-out in the
// middle of a call, for a change that has nothing to do with the microphone.
// The prefix cannot be confused for the audio one: MEMBER_PATH_PATTERN anchors
// on `voice-` immediately followed by the uuid.
const CAMERA_PATH_PATTERN =
  /^voicecam-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i;

// Long enough to cover a match without a client ever having to re-ask
// mid-connection, short enough that a leaked pair is not worth much. The
// credential is only checked when a peer connection is established, so an
// expiry part-way through a call does not interrupt one already running.
const TURN_CREDENTIAL_TTL = 6 * 60 * 60;

export type RTCIceServerConfig = {
  urls: string | Array<string>;
  username?: string;
  credential?: string;
};

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
  // Coaching this lineup rather than playing on it. Worth saying: a coach in a
  // team channel is a different thing to a teammate, and the roster on screen
  // should not make you work out which of the five voices is not playing.
  coach: boolean;
  // Publishing a camera as well. Independent of `connected` on purpose: being in
  // the call and being on camera are separate choices, and either can be true
  // without the other.
  video: boolean;
};

type VoiceMember = {
  steam_id: string;
  name: string | null;
  avatar_url: string | null;
  coach: boolean;
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

  public static pathForMemberCamera(lobbyId: string, steamId: string) {
    return `voicecam-${lobbyId}-${steamId}`;
  }

  private static speakingKey(channelId: string, steamId: string) {
    return `voice:speaking:${channelId}:${steamId}`;
  }

  private static membersKey(channelId: string) {
    return `voice:members:${channelId}`;
  }

  private static readonly PUBLISHING_KEY_PREFIX = "voice:publishing:";

  private static publishingKey(channelId: string) {
    return `${VoiceService.PUBLISHING_KEY_PREFIX}${channelId}`;
  }

  // The inverse of pathForMember, kept beside it so the two cannot drift.
  public static parseMemberPath(path: string) {
    const match = MEMBER_PATH_PATTERN.exec(path);

    return match ? { channelId: match[1], steamId: match[2] } : null;
  }

  public static parseCameraPath(path: string) {
    const match = CAMERA_PATH_PATTERN.exec(path);

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

  // ICE servers for a voice or video peer connection.
  //
  // Deliberately an endpoint rather than a constant in the web bundle: the TURN
  // secret never leaves this process, credentials expire on their own, and a
  // relay can be switched on or off without shipping a web build.
  //
  // Handed only to the call surfaces. The regional matchmaking probes must keep
  // their own STUN-only list -- they open a data channel per region and time it,
  // so a relay candidate would measure the hop to the relay instead of the
  // region -- and so must game streams, where relaying is a bandwidth disaster.
  public iceServers(user: User) {
    return VoiceService.buildIceServers(user.steam_id);
  }

  // Static, and keyed on a steam id rather than a User, so the camera feature
  // can mint the same credentials for a phone holding a join token. That phone
  // has no session -- and is the case a relay exists for, since a mobile network
  // is behind carrier-grade NAT by definition.
  public static buildIceServers(steamId: string): {
    iceServers: Array<RTCIceServerConfig>;
    ttl: number;
  } {
    const stun: RTCIceServerConfig = {
      urls: "stun:stun.l.google.com:19302",
    };

    const domain = process.env.TURN_DOMAIN;
    const secret = process.env.TURN_SECRET;

    // No relay configured is the normal case for a small install, not an error:
    // STUN alone is enough for most players.
    if (!domain || !secret) {
      return { iceServers: [stun], ttl: 0 };
    }

    // coturn's REST scheme: the username carries its own expiry, and the
    // password is an HMAC of it. Nothing has to be stored on either side, and a
    // leaked pair stops working on its own.
    const expiresAt = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL;
    const username = `${expiresAt}:${steamId}`;
    const credential = createHmac("sha1", secret)
      .update(username)
      .digest("base64");

    return {
      iceServers: [
        stun,
        {
          // TCP as well as UDP: the networks that need a relay at all are
          // usually the ones blocking UDP outright.
          urls: [
            `turn:${domain}:3478?transport=udp`,
            `turn:${domain}:3478?transport=tcp`,
          ],
          username,
          credential,
        },
      ],
      ttl: TURN_CREDENTIAL_TTL,
    };
  }

  // On unless explicitly disabled, like voice. Only the camera switch -- whether
  // voice itself is on is assertMember's business, and asking twice is a second
  // settings round trip per negotiation.
  public async isVideoEnabled() {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.VideoChatEnabled],
    );

    return row?.value !== "false";
  }

  private async assertVideoMember(channelId: string, user: User) {
    await this.assertMember(channelId, user);

    if (!(await this.isVideoEnabled())) {
      throw new Error("video chat is not enabled");
    }
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

    await this.assertMembership(channelId, user);
  }

  // Membership on its own, with no feature switch in front of it. Everything
  // that starts something asks assertMember; the teardown paths ask this,
  // because switching voice off platform-wide must not strand a microphone or a
  // camera nobody can now stop publishing.
  private async assertMembership(channelId: string, user: User) {
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

    // Rostered on the lineup, or coaching it. A coach is not a
    // match_lineup_players row, but talking to the side they are coaching is
    // the whole job -- so membership is asked of the lineup, not of its roster.
    const [lineup] = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT true AS exists
       FROM match_lineups ml
       INNER JOIN matches m
         ON m.lineup_1_id = ml.id
         OR m.lineup_2_id = ml.id
       WHERE ml.id = $1
         AND m.status NOT IN ('Finished', 'Canceled', 'Forfeit', 'Surrendered', 'Tie')
         AND (
           ml.coach_steam_id = $2
           OR EXISTS (
             SELECT 1
             FROM match_lineup_players mlp
             WHERE mlp.match_lineup_id = ml.id
               AND mlp.steam_id = $2
           )
         )
       LIMIT 1`,
      [channelId, user.steam_id],
    );

    if (lineup?.exists) {
      return;
    }

    throw new Error(NOT_A_MEMBER);
  }

  // Which channel this player already has a live microphone on, if any.
  //
  // The web app mirrors a running call between tabs over a BroadcastChannel,
  // which only ever reaches tabs of the same browser profile -- a second window
  // signed in under a different profile, another browser, or a phone sees
  // nothing and cheerfully offers to join a call the player is already in.
  // MediaMTX knows the truth for all of them, so this asks it.
  public async activeChannel(user: User) {
    const paths = await this.mediaMtx.listPaths();

    // Unreachable is not the same as "not in a call": answering null here would
    // have the client draw a join button for a call that is still running.
    if (!paths) {
      return { known: false, channelId: null, video: false };
    }

    for (const [path, state] of paths) {
      if (!state?.ready) {
        continue;
      }

      const member = VoiceService.parseMemberPath(path);

      if (member?.steamId !== user.steam_id) {
        continue;
      }

      return {
        known: true,
        channelId: member.channelId,
        video:
          paths.get(
            VoiceService.pathForMemberCamera(member.channelId, member.steamId),
          )?.ready === true,
      };
    }

    return { known: true, channelId: null, video: false };
  }

  public async publish(lobbyId: string, user: User, sdp: string) {
    await this.assertMember(lobbyId, user);

    return this.publishAs(lobbyId, user.steam_id, sdp);
  }

  // Keyed on a steam id rather than a User so the token paths can reuse it --
  // a phone joining is the same publish, it just proved who it was differently.
  // Callers do the authorising; this only does the work.
  private async publishAs(lobbyId: string, steamId: string, sdp: string) {
    const answer = await this.mediaMtx.proxySdp(
      VoiceService.pathForMember(lobbyId, steamId),
      "whip",
      sdp,
    );

    // Somebody joining is a change to the party, and it is the one moment a
    // stale membership cache would hide the new arrival from everyone else.
    await this.redis.del(VoiceService.membersKey(lobbyId));
    this.pushParticipantsSoon(lobbyId);

    return answer;
  }

  // Deferred: MediaMTX reports a path as ready only once the session is really
  // up, and keeps reporting it until the session is really gone -- both of which
  // land after the answer or the kick has returned here. Reading the path list
  // straight afterwards describes the call as it was, not as it now is.
  //
  // Twice, because that moment cannot be predicted, only bracketed. A single
  // one-second wait was tuned to always be late enough, which made every camera
  // coming on cost a second before anyone else saw it. The early push usually
  // lands; the late one is one extra message per member and settles the rest.
  private pushParticipantsSoon(lobbyId: string) {
    for (const delay of [250, 1200]) {
      setTimeout(() => {
        void this.pushParticipants(lobbyId).catch((error: unknown) => {
          this.logger.warn(
            `failed to push voice participants for ${lobbyId}: ${
              (error as Error)?.message
            }`,
          );
        });
      }, delay);
    }
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
    await this.assertMembership(lobbyId, user);

    await this.mediaMtx.kickSessions(
      VoiceService.pathForMember(lobbyId, user.steam_id),
    );
    // A camera outlives its microphone otherwise: the member is gone from the
    // call but their tile keeps playing for everyone still in it.
    await this.mediaMtx.kickSessions(
      VoiceService.pathForMemberCamera(lobbyId, user.steam_id),
    );

    await this.redis.del(VoiceService.speakingKey(lobbyId, user.steam_id));
    this.pushParticipantsSoon(lobbyId);
  }

  // The camera half of publish/subscribe/leave above. Same membership gate, same
  // proxy, a different path -- see CAMERA_PATH_PATTERN for why it is not simply
  // a second track on the audio one.
  public async publishVideo(lobbyId: string, user: User, sdp: string) {
    await this.assertVideoMember(lobbyId, user);

    return this.publishVideoAs(lobbyId, user.steam_id, sdp);
  }

  private async publishVideoAs(lobbyId: string, steamId: string, sdp: string) {
    const answer = await this.mediaMtx.proxySdp(
      VoiceService.pathForMemberCamera(lobbyId, steamId),
      "whip",
      sdp,
    );

    this.pushParticipantsSoon(lobbyId);

    return answer;
  }

  public async subscribeVideo(
    lobbyId: string,
    steamId: string,
    user: User,
    sdp: string,
  ) {
    await this.assertVideoMember(lobbyId, user);

    if (steamId === user.steam_id) {
      throw new Error("cannot subscribe to your own camera");
    }

    return this.mediaMtx.proxySdp(
      VoiceService.pathForMemberCamera(lobbyId, steamId),
      "whep",
      sdp,
    );
  }

  // Turning a camera off, without leaving the call. Deliberately gated on
  // membership alone rather than assertVideoMember: switching the feature off
  // platform-wide must not strand a camera nobody can now stop publishing.
  public async stopVideo(lobbyId: string, user: User) {
    await this.assertMembership(lobbyId, user);

    await this.mediaMtx.kickSessions(
      VoiceService.pathForMemberCamera(lobbyId, user.steam_id),
    );

    this.pushParticipantsSoon(lobbyId);
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
    // Grouped rather than plain UNION: someone who is both rostered and listed
    // as the coach would otherwise arrive as two rows that differ only in the
    // flag, and be counted twice in their own channel.
    const members = await this.postgres.query<Array<VoiceMember>>(
      `SELECT steam_id::text AS steam_id,
              MAX(name) AS name,
              MAX(avatar_url) AS avatar_url,
              bool_or(coach) AS coach
       FROM (
         SELECT lp.steam_id, p.name, p.avatar_url, false AS coach
         FROM lobby_players lp
         LEFT JOIN players p ON p.steam_id = lp.steam_id
         WHERE lp.lobby_id = $1 AND lp.status = 'Accepted'

         UNION ALL

         SELECT mlp.steam_id, p.name, p.avatar_url, false AS coach
         FROM match_lineup_players mlp
         LEFT JOIN players p ON p.steam_id = mlp.steam_id
         WHERE mlp.match_lineup_id = $1

         UNION ALL

         -- The coach is in the channel too, and this list is what decides who
         -- gets the speaking and participant pushes -- leaving them out would
         -- admit them and then never tell them anything.
         SELECT ml.coach_steam_id AS steam_id, p.name, p.avatar_url, true AS coach
         FROM match_lineups ml
         LEFT JOIN players p ON p.steam_id = ml.coach_steam_id
         WHERE ml.id = $1 AND ml.coach_steam_id IS NOT NULL
       ) members
       GROUP BY steam_id
       ORDER BY MAX(name)`,
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
      // Read out of the map already in hand rather than asked for separately --
      // the monitor lists every path on the box once for all channels.
      const camera = paths?.get(
        VoiceService.pathForMemberCamera(channelId, member.steam_id),
      );

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
        coach: member.coach === true,
        video: camera?.ready === true,
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
  // A channel that empties completely is still reported. `push` addresses the
  // whole member list, not just the publishers, so there is somebody to tell:
  // a teammate with the lobby open who never joined the call would otherwise
  // keep rendering everyone as connected until the snapshot aged out on its own.
  public async monitorChannels() {
    const paths = await this.mediaMtx.listPaths();

    // Fail open, like the camera monitor: an unreachable MediaMTX cannot be
    // told apart from an empty one, and emptying every call on our own outage
    // is far worse than being a pass late on a drop.
    if (!paths) {
      this.logger.warn("[voice] skipping monitor pass: mediamtx did not answer");
      return;
    }

    // Cameras are tracked alongside microphones, not instead of them: a member
    // who turns their camera off while staying on mic does not change the set of
    // steam ids, so a snapshot of ids alone would report no change and leave
    // everyone else rendering a tile that stopped publishing.
    const publishing = new Map<string, Map<string, { video: boolean }>>();

    function entryFor(channelId: string, steamId: string) {
      const channel = publishing.get(channelId) ?? new Map();
      publishing.set(channelId, channel);

      const entry = channel.get(steamId) ?? { video: false };
      channel.set(steamId, entry);

      return entry;
    }

    for (const [path, state] of paths) {
      if (!state?.ready) {
        continue;
      }

      const member = VoiceService.parseMemberPath(path);

      if (member) {
        entryFor(member.channelId, member.steamId);
        continue;
      }

      const camera = VoiceService.parseCameraPath(path);

      if (camera) {
        entryFor(camera.channelId, camera.steamId).video = true;
      }
    }

    for (const [channelId, members] of publishing) {
      // A member on mic alone is written exactly as before, so the snapshots a
      // running deployment already holds stay comparable across the deploy that
      // adds video -- otherwise every live channel reads as changed once and
      // pushes to everyone at the same moment.
      const snapshot = [...members.entries()]
        .map(([steamId, entry]) => (entry.video ? `${steamId}:v` : steamId))
        .sort()
        .join(",");
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

    // Channels that emptied since the last pass are not in `publishing` at all,
    // so the loop above never visits them. Their snapshot is what says they were
    // occupied a moment ago.
    for (const key of await this.emptiedChannelKeys(publishing)) {
      await this.redis.del(key);

      await this.pushParticipants(
        key.slice(VoiceService.PUBLISHING_KEY_PREFIX.length),
        paths,
      );
    }
  }

  private async emptiedChannelKeys(
    publishing: Map<string, unknown>,
  ): Promise<string[]> {
    const emptied: string[] = [];
    let cursor = "0";

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${VoiceService.PUBLISHING_KEY_PREFIX}*`,
        "COUNT",
        100,
      );

      cursor = next;

      for (const key of keys) {
        const channelId = key.slice(
          VoiceService.PUBLISHING_KEY_PREFIX.length,
        );

        if (!publishing.has(channelId)) {
          emptied.push(key);
        }
      }
    } while (cursor !== "0");

    return emptied;
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
