// The message of every refused news comment action, and of the rules the
// triggers in hasura/triggers/news_comments.sql raise. The web translates these,
// so add to it, never rename.
export enum NewsCommentError {
  SignIn = "news_comment_sign_in",
  NotVerified = "news_comment_not_verified",
  Banned = "news_comment_banned",
  Gagged = "news_comment_gagged",
  NotFound = "news_comment_not_found",
  Closed = "news_comment_closed",
  Empty = "news_comment_empty",
  TooLong = "news_comment_too_long",
  ParentRemoved = "news_comment_parent_removed",
  RateLimited = "news_comment_rate_limited",
  DailyLimit = "news_comment_daily_limit",
  NotYours = "news_comment_not_yours",
  EditWindow = "news_comment_edit_window",
  Removed = "news_comment_removed",
  OwnVote = "news_comment_own_vote",
  StaffOnly = "news_comment_staff_only",
  Immutable = "news_comment_immutable",
}
