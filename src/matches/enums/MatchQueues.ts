export enum MatchQueues {
  MatchServers = "match-servers",
  ScheduledMatches = "scheduled-matches",
  EloCalculation = "elo-calculation",
  // Batch highlight rendering — one queued job per match_map.
  // Worker (BatchHighlightsRenderJob) owns the lifecycle: dispatch
  // pod, poll k8s job + clip_render_jobs status, redispatch on pod
  // death, force-kill on hard timeout. Concurrency=1 globally so
  // we don't spin up a GPU pod per match_map in parallel.
  ClipRenderBatch = "clip-render-batch",
}
