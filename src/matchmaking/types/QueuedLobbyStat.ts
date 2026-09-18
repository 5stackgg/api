// One lobby waiting in a region's queue, as broadcast to clients. The index is
// stable across the regions a lobby queued for, so multi-region lobbies are
// counted once; players is the lobby's size, because the queue count people
// care about is how many are waiting, not how many parties are.
export interface QueuedLobbyStat {
  lobby: number;
  players: number;
}
