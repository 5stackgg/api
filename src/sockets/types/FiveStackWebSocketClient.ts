import WebSocket from "ws";
import { User } from "src/auth/types/User";

export type FiveStackWebSocketClient = WebSocket.WebSocket & {
  id: string;
  user: User;
  node: string;
};
