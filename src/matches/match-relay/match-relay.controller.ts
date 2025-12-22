import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Param,
} from "@nestjs/common";
import { Request, Response } from "express";
import { EventEmitter } from "events";
import { MatchRelayService } from "./match-relay.service";

@Controller("matches/:id/relay")
export class MatchRelayController {
  constructor(private readonly matchRelayService: MatchRelayService) {}
  @Post("*path")
  public async handlePost(
    @Param("id") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    // Rewrite URL: /matches/:id/relay/fragment/field -> /:id/fragment/field
    // Or: /matches/:id/relay/token/fragment/field -> /token/fragment/field (if token present)
    const originalUrl = request.url;
    const urlPath = originalUrl.split("?")[0];
    const pathParts = urlPath.split("/").filter(Boolean);
    
    const relayIndex = pathParts.indexOf("relay");
    if (relayIndex === -1) {
      return response.status(405).send("Invalid path");
    }
    
    const afterRelay = pathParts.slice(relayIndex + 1);
    
    // Handle /sync endpoint specially
    let newPath: string;
    if (afterRelay.length === 1 && afterRelay[0] === "sync") {
      newPath = "/sync" + (originalUrl.includes("?") ? originalUrl.substring(originalUrl.indexOf("?")) : "");
      // Set token_redirect_for_example to matchId so sync can find it
      if (
        !this.matchRelayService.getTokenRedirect() &&
        this.matchRelayService.getMatchBroadcasts()[matchId]
      ) {
        this.matchRelayService.setTokenRedirect(matchId);
      }
    } else {
      // Check if first part after relay looks like a token (starts with 's' and has 't')
      // If not, use matchId as the prime identifier
      let prime: string;
      let fragmentAndField: string[];
      
      if (afterRelay.length > 0 && /^s\d+t\d+/.test(afterRelay[0])) {
        // Token present: use token as prime
        prime = afterRelay[0];
        fragmentAndField = afterRelay.slice(1);
      } else {
        // No token: use matchId as prime
        prime = matchId;
        fragmentAndField = afterRelay;
      }
      
      newPath = "/" + [prime, ...fragmentAndField].join("/") + (originalUrl.includes("?") ? originalUrl.substring(originalUrl.indexOf("?")) : "");
    }
    
    // Get raw body - must be Buffer from middleware
    const rawBody = (request as any).rawBody || request.body;
    const bodyBuffer = Buffer.isBuffer(rawBody) 
      ? rawBody 
      : (rawBody 
          ? (typeof rawBody === 'string' 
              ? Buffer.from(rawBody, 'utf8') 
              : Buffer.from(rawBody))
          : Buffer.alloc(0));
    
    // Create adapted request that emits body as stream
    // Copy all properties from original request
    const adaptedRequest = Object.create(request);
    // Override url but keep everything else
    Object.defineProperty(adaptedRequest, 'url', {
      value: newPath,
      writable: true,
      enumerable: true,
      configurable: true
    });
    // Ensure method is set
    if (!adaptedRequest.method) {
      adaptedRequest.method = request.method;
    }
    
    // Make it streamable with EventEmitter
    const emitter = new EventEmitter();
    // Set up event listeners on the emitter
    adaptedRequest.on = emitter.on.bind(emitter);
    adaptedRequest.once = emitter.once.bind(emitter);
    adaptedRequest.emit = emitter.emit.bind(emitter);
    adaptedRequest.removeListener = emitter.removeListener.bind(emitter);
    adaptedRequest.removeAllListeners = emitter.removeAllListeners.bind(emitter);
    adaptedRequest.addListener = emitter.addListener.bind(emitter);
    
    // Call the service to process the request
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
    
    // Then emit body data asynchronously (after listeners are set up)
    // Use setImmediate to ensure listeners are registered first
    setImmediate(() => {
      if (bodyBuffer.length > 0) {
        emitter.emit("data", bodyBuffer);
      }
      emitter.emit("end");
    });
  }

  @Get("*path")
  public handleGet(
    @Param("id") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    // Same URL rewriting as POST
    const originalUrl = request.url;
    const urlPath = originalUrl.split("?")[0];
    const pathParts = urlPath.split("/").filter(Boolean);
    
    const relayIndex = pathParts.indexOf("relay");
    if (relayIndex === -1) {
      return response.status(405).send("Invalid path");
    }
    
    const afterRelay = pathParts.slice(relayIndex + 1);
    
    // Handle /sync endpoint specially
    let newPath: string;
    if (afterRelay.length === 1 && afterRelay[0] === "sync") {
      newPath = "/sync" + (originalUrl.includes("?") ? originalUrl.substring(originalUrl.indexOf("?")) : "");
      // Set token_redirect_for_example to matchId so sync can find it
      if (
        !this.matchRelayService.getTokenRedirect() &&
        this.matchRelayService.getMatchBroadcasts()[matchId]
      ) {
        this.matchRelayService.setTokenRedirect(matchId);
      }
    } else {
      // Check if first part after relay looks like a token (starts with 's' and has 't')
      // If not, use matchId as the prime identifier
      let prime: string;
      let fragmentAndField: string[];
      
      if (afterRelay.length > 0 && /^s\d+t\d+/.test(afterRelay[0])) {
        // Token present: use token as prime
        prime = afterRelay[0];
        fragmentAndField = afterRelay.slice(1);
      } else {
        // No token: use matchId as prime
        prime = matchId;
        fragmentAndField = afterRelay;
      }
      
      newPath = "/" + [prime, ...fragmentAndField].join("/") + (originalUrl.includes("?") ? originalUrl.substring(originalUrl.indexOf("?")) : "");
    }
    
    const adaptedRequest = Object.create(request);
    adaptedRequest.url = newPath;
    
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }
}
