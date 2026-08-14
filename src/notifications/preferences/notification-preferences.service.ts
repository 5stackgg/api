import { BadRequestException, Injectable } from "@nestjs/common";
import { PostgresService } from "../../postgres/postgres.service";
import {
  NotificationChannel,
  PreferenceKey,
  keysForChannel,
  inAppKeyForType,
} from "./notification-categories";

export type QuietHours = {
  start: string | null;
  end: string | null;
  timezone: string | null;
};

export type ResolvedPreference = PreferenceKey & {
  enabled: boolean;
};

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly postgres: PostgresService) {}

  // Returns the whole catalogue merged with the player's stored choices, so
  // the frontend renders toggles without needing its own copy of the key list
  // or of what each key defaults to.
  public async list(
    steamId: string,
    channel: NotificationChannel,
  ): Promise<ResolvedPreference[]> {
    const rows = await this.postgres.query<
      Array<{ key: string; enabled: boolean }>
    >(
      `SELECT key, enabled
         FROM public.notification_preferences
        WHERE steam_id = $1::bigint AND channel = $2`,
      [steamId, channel],
    );

    const stored = new Map(rows.map((row) => [row.key, row.enabled]));

    return keysForChannel(channel).map((entry) => ({
      ...entry,
      enabled: stored.get(entry.key) ?? entry.defaultEnabled,
    }));
  }

  public async set(
    steamId: string,
    channel: NotificationChannel,
    key: string,
    enabled: boolean,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.notification_preferences (steam_id, channel, key, enabled)
            VALUES ($1::bigint, $2, $3, $4)
       ON CONFLICT (steam_id, channel, key) DO UPDATE
               SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [steamId, channel, key, enabled],
    );
  }

  // Deleting restores default-by-absence, which is the whole point of storing
  // only explicit choices.
  public async reset(
    steamId: string,
    channel: NotificationChannel,
    key: string,
  ): Promise<void> {
    await this.postgres.query(
      `DELETE FROM public.notification_preferences
             WHERE steam_id = $1::bigint AND channel = $2 AND key = $3`,
      [steamId, channel, key],
    );
  }

  public async getQuietHours(steamId: string): Promise<QuietHours> {
    const [row] = await this.postgres.query<QuietHours[]>(
      `SELECT to_char(quiet_hours_start, 'HH24:MI') AS start,
              to_char(quiet_hours_end, 'HH24:MI') AS "end",
              notification_timezone AS timezone
         FROM public.players
        WHERE steam_id = $1::bigint`,
      [steamId],
    );

    return row ?? { start: null, end: null, timezone: null };
  }

  public async setQuietHours(
    steamId: string,
    quietHours: QuietHours,
  ): Promise<void> {
    const start = quietHours.start || null;
    const end = quietHours.end || null;

    if ((start === null) !== (end === null)) {
      throw new BadRequestException("quiet hours need both a start and an end");
    }

    for (const value of [start, end]) {
      if (value !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new BadRequestException(`invalid time: ${value}`);
      }
    }

    // An unknown zone would make `AT TIME ZONE` raise inside the recipient
    // query, which would silence push for everyone rather than for this player.
    // is_quiet_hours falls back to UTC as a second line of defence, but a bad
    // value should never get stored in the first place.
    const timezone = quietHours.timezone || null;
    if (timezone) {
      const [known] = await this.postgres.query<Array<{ name: string }>>(
        `SELECT name FROM pg_timezone_names WHERE name = $1 LIMIT 1`,
        [timezone],
      );

      if (!known) {
        throw new BadRequestException(`unknown timezone: ${timezone}`);
      }
    }

    await this.postgres.query(
      `UPDATE public.players
          SET quiet_hours_start = $2::time,
              quiet_hours_end = $3::time,
              notification_timezone = $4
        WHERE steam_id = $1::bigint`,
      [steamId, start, end, timezone],
    );
  }

  // Narrows a recipient list to those who haven't muted this type in the bell.
  //
  // Unlike push, this has to happen before the rows are written: the bell reads
  // `notifications` straight through Hasura, and "hide rows whose type the
  // viewer muted" isn't expressible as a select_permission.
  public async filterInAppRecipients(
    type: string,
    steamIds: string[],
  ): Promise<string[]> {
    const key = inAppKeyForType(type);

    if (!key || steamIds.length === 0) {
      return steamIds;
    }

    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT s.steam_id::text AS steam_id
         FROM unnest($1::bigint[]) AS s(steam_id)
    LEFT JOIN public.notification_preferences np
           ON np.steam_id = s.steam_id
          AND np.channel = 'in_app'
          AND np.key = $2
        WHERE COALESCE(np.enabled, $3::boolean) = true`,
      [steamIds, key.key, key.defaultEnabled],
    );

    return rows.map((row) => row.steam_id);
  }
}
