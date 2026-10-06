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
  TooLarge = "too_large",
  UnsupportedType = "unsupported_type",
  TooManyPending = "too_many_pending",
  Disabled = "disabled",
  Unavailable = "unavailable",
  QuotaExceeded = "quota_exceeded",
  Busy = "busy",
  AlreadySent = "already_sent",
  // A message request is out and the other side has not replied to it yet.
  AwaitingReply = "awaiting_reply",
}
