// The plugin's own calibration verdicts (eCalibrationStatus), plus the
// refusals that never reach a server. They are separate values on purpose:
// "your runtime cannot do this" and "nobody has thrown a grenade yet" are both
// actionable, and both different from a generic failure.
export enum UtilitySolverStatus {
  Ready = "Ready",
  NoSample = "NoSample",
  LaunchModelMismatch = "LaunchModelMismatch",
  SeedReplayMismatch = "SeedReplayMismatch",
  SeedReplayTimedOut = "SeedReplayTimedOut",
  Unsupported = "Unsupported",
  // The plugin has been asked and has not decided yet: calibration runs
  // asynchronously, so an uncalibrated map answers this once and a verdict on
  // the next call.
  Unknown = "Unknown",
  Busy = "Busy",
  Unreachable = "Unreachable",
  NotHost = "NotHost",
  NotLive = "NotLive",
  NoServer = "NoServer",
  // Repair refusals. A repair is a solve aimed at a lineup's own landing point,
  // so it can be turned away for reasons a bare solve has no opinion about:
  // there is no verdict to act on, the verdict is not one a re-solve can fix, or
  // the lineup was never replayable in the first place.
  NotScanned = "NotScanned",
  NotMoved = "NotMoved",
  Seedless = "Seedless",
  WrongMap = "WrongMap",
  // Accepted: the search is queued and its lineup will arrive over
  // POST /utility/ingest, not through the action that started it.
  Solving = "Solving",
}
