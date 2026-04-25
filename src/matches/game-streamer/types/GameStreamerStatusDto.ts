// Body of POST /game-streamer/:matchId/status. The streamer pod posts
// this as it walks through its boot sequence; only the latest write
// matters (the GLS daemon retries with latest-wins semantics).
//
// `status` is free-form to keep the set of values a deploy concern of
// the streamer image rather than a schema migration. Known values today:
//   launching_steam | logging_in | downloading_cs2 | launching_cs2
//   | connecting_to_game | live | errored
export interface GameStreamerStatusDto {
  status: string;
  // Set only when status === "live". The SRT publish URL the operator
  // can scrub for diagnostics. The viewer-facing HLS URL is set by the
  // API at row-insert time and lives on `match_streams.link`.
  stream_url?: string;
  // Set only when status === "errored". Surfaced to the operator on
  // the match_streams row so they can see why the boot failed.
  error?: string;
}
