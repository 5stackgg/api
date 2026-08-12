import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class MediaMtxService {
  constructor(private readonly logger: Logger) {}

  // A MediaMTX path is one URL segment, so it is encoded rather than
  // interpolated: an unencoded `..` in a caller-supplied path component
  // resolves away the prefix and reaches a different path entirely
  // (`camera-<mine>-../../camera-<theirs>-<victim>` -> `camera-<theirs>-<victim>`).
  private encodePath(path: string) {
    return encodeURIComponent(path);
  }

  private apiBase() {
    return (process.env.MEDIAMTX_API_BASE || "http://mediamtx:9997").replace(
      /\/$/,
      "",
    );
  }

  private whipBase() {
    return (process.env.MEDIAMTX_WHIP_BASE || "http://mediamtx:8889").replace(
      /\/$/,
      "",
    );
  }

  public async proxySdp(path: string, action: "whip" | "whep", sdp: string) {
    let response: Response;

    try {
      response = await fetch(
        `${this.whipBase()}/${this.encodePath(path)}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp",
          },
          body: sdp,
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      this.logger.error(
        `[mediamtx] ${action} proxy to ${path} failed: ${(error as Error)?.message}`,
      );
      throw new Error("signaling service unreachable");
    }

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `mediamtx ${path}/${action} responded ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    return body;
  }

  // Null means "could not ask", which callers must not confuse with "nothing is
  // publishing" — an empty map is a real answer, null is an outage.
  public async listPaths(): Promise<Map<
    string,
    { ready: boolean; bytesReceived: number }
  > | null> {
    try {
      const response = await fetch(`${this.apiBase()}/v3/paths/list`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        return null;
      }

      const { items } = (await response.json()) as {
        items?: Array<{
          name?: string;
          ready?: boolean;
          bytesReceived?: number;
        }>;
      };

      const paths = new Map<string, { ready: boolean; bytesReceived: number }>();

      for (const item of items ?? []) {
        if (!item?.name) {
          continue;
        }

        paths.set(item.name, {
          ready: item.ready === true,
          bytesReceived: Number(item.bytesReceived ?? 0),
        });
      }

      return paths;
    } catch (error) {
      this.logger.warn(
        `[mediamtx] listing paths failed: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  public async isPathReady(path: string) {
    try {
      const response = await fetch(
        `${this.apiBase()}/v3/paths/get/${this.encodePath(path)}`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );

      if (!response.ok) {
        return false;
      }

      const { ready } = (await response.json()) as { ready?: boolean };

      return ready === true;
    } catch (error) {
      this.logger.warn(
        `[mediamtx] status check for ${path} failed: ${(error as Error)?.message}`,
      );
      return false;
    }
  }

  // Dropping the publisher is what actually ends a session for everyone
  // attached to the path — there is no per-viewer teardown to coordinate.
  public async kickSessions(path: string) {
    try {
      const response = await fetch(
        `${this.apiBase()}/v3/webrtcsessions/list`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );

      if (!response.ok) {
        return;
      }

      const { items } = (await response.json()) as {
        items?: Array<{ id: string; path?: string }>;
      };

      await Promise.all(
        (items ?? [])
          .filter((session) => session.path === path)
          .map((session) => {
            return fetch(
              `${this.apiBase()}/v3/webrtcsessions/kick/${this.encodePath(session.id)}`,
              {
                method: "POST",
                signal: AbortSignal.timeout(5_000),
              },
            ).catch(() => {});
          }),
      );
    } catch (error) {
      // Best effort: if the control API is unreachable the WebRTC connection
      // still times out and settles on its own.
      this.logger.warn(
        `[mediamtx] kick sessions for ${path} failed: ${(error as Error)?.message}`,
      );
    }
  }
}
