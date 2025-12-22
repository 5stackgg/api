import { Injectable } from "@nestjs/common";
import { IncomingMessage, ServerResponse } from "http";
import {
  processRequest,
  match_broadcasts,
  token_redirect_for_example,
  stats,
} from "./playcast-reference";

@Injectable()
export class MatchRelayService {
  /**
   * Process a playcast request using the reference implementation
   */
  processRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    processRequest(request, response);
  }

  /**
   * Get the match broadcasts storage
   */
  getMatchBroadcasts(): { [key: string]: any[] } {
    return match_broadcasts;
  }

  /**
   * Get the current token redirect value
   */
  getTokenRedirect(): string | null {
    return token_redirect_for_example.value;
  }

  /**
   * Set the token redirect value
   */
  setTokenRedirect(value: string | null): void {
    token_redirect_for_example.value = value;
  }

  /**
   * Get stats
   */
  getStats(): any {
    return stats;
  }
}

