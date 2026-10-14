// Sent back to the web as `?twitch_error=<code>` for it to translate.
export type TwitchLinkError =
  | "not_configured"
  | "invalid_state"
  | "denied"
  | "already_linked"
  | "twitch_unavailable";
