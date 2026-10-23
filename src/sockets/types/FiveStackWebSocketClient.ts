import WebSocket from "ws";
import { User } from "src/auth/types/User";

export type FiveStackWebSocketClient = WebSocket.WebSocket & {
  id: string;
  user: User;
  node: string;
  sessionId: string;
  peerNodes: Set<string>;
  signalPeers: Map<string, Promise<string | undefined>>;
  lastSeenAt: number;
  authentication?: Promise<void>;
  lanRegion?: string | null;
  lanClosed?: boolean;
  lanQueue?: Promise<void>;
};
