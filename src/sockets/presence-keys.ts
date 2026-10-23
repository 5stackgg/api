// Redis keys presence shares between SocketsService and PresenceService.
export const playerKey = (steamId: string) => `players:${steamId}`;

export const playerClientsKey = (steamId: string) => `clients:${steamId}`;

export const playerClientKey = (
  steamId: string,
  nodeId: string,
  clientId: string,
) => `${playerClientsKey(steamId)}:${nodeId}:${clientId}`;

// Written by the game server node connector's LAN probe, one field per region.
export const latencyTestKey = (sessionId: string) =>
  `latency-test:${sessionId}`;
