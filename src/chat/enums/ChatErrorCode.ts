// Sent to the client as `chat:error { code }`, so these values are a contract
// with the web -- add to it, never rename.
export enum ChatErrorCode {
  TooLong = "too_long",
  NotAllowed = "not_allowed",
  Invalid = "invalid",
  Gagged = "gagged",
  NotFound = "not_found",
  WindowClosed = "window_closed",
  RateLimited = "rate_limited",
}
