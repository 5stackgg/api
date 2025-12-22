import { Controller, Get, Post, Req, Res, Param, Query } from "@nestjs/common";
import { Request, Response } from "express";
import { EventEmitter } from "events";
import { MatchRelayService } from "./match-relay.service";

@Controller("matches/:id/relay")
export class MatchRelayController {
  constructor(private readonly matchRelayService: MatchRelayService) {}

  @Get("sync")
  public handleSyncGet(
    @Param("id") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/sync${queryString}`;

    // Set token_redirect to matchId so sync can find it
    if (
      !this.matchRelayService.getTokenRedirect() &&
      this.matchRelayService.getMatchBroadcasts()[matchId]
    ) {
      this.matchRelayService.setTokenRedirect(matchId);
    }

    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Get(":fragment/start")
  public handleGetStart(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${matchId}/${fragment}/start${queryString}`;
    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Get(":fragment/full")
  public handleGetFull(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${matchId}/${fragment}/full${queryString}`;
    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Get(":fragment/delta")
  public handleGetDelta(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${matchId}/${fragment}/delta${queryString}`;
    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Get(":token/:fragment/start")
  public handleGetStartWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${token}/${fragment}/start${queryString}`;
    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Get(":token/:fragment/full")
  public handleGetFullWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${token}/${fragment}/full${queryString}`;
    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Get(":token/:fragment/delta")
  public handleGetDeltaWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${token}/${fragment}/delta${queryString}`;
    const adaptedRequest = this.createAdaptedRequest(request, newPath);
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
    );
  }

  @Post(":token/:fragment/start")
  public async handlePostStart(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${token}/${fragment}/start${queryString}`;
    await this.handlePostWithBody(request, response, newPath, matchId);
  }

  @Post(":token/:fragment/full")
  public async handlePostFull(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${token}/${fragment}/full${queryString}`;
    await this.handlePostWithBody(request, response, newPath, matchId);
  }

  @Post(":token/:fragment/delta")
  public async handlePostDelta(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: Record<string, any>,
  ) {
    const queryString = this.buildQueryString(query);
    const newPath = `/${token}/${fragment}/delta${queryString}`;
    await this.handlePostWithBody(request, response, newPath, matchId);
  }

  @Get("*path")
  public handleGetWildcard(
    @Param("id") matchId: string,
    @Param("path") path: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    console.warn(
      `Unmatched GET request pattern: ${request.url} (path: ${path})`,
    );
    return response.status(404).send("Not found");
  }

  @Post("*path")
  public handlePostWildcard(
    @Param("id") matchId: string,
    @Param("path") path: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    console.warn(
      `Unmatched POST request pattern: ${request.url} (path: ${path})`,
    );
    return response.status(404).send("Not found");
  }

  private buildQueryString(query: Record<string, any>): string {
    if (Object.keys(query).length === 0) {
      return "";
    }
    return "?" + new URLSearchParams(query).toString();
  }

  private createAdaptedRequest(request: Request, newPath: string): any {
    const adaptedRequest = Object.create(request);
    adaptedRequest.url = newPath;
    return adaptedRequest;
  }

  private async handlePostWithBody(
    request: Request,
    response: Response,
    newPath: string,
    matchId?: string,
  ): Promise<void> {
    // Get raw body - must be Buffer from middleware
    const rawBody = (request as any).rawBody || request.body;
    const bodyBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : rawBody
        ? typeof rawBody === "string"
          ? Buffer.from(rawBody, "utf8")
          : Buffer.from(rawBody)
        : Buffer.alloc(0);

    // Create adapted request that emits body as stream
    const adaptedRequest = Object.create(request);
    Object.defineProperty(adaptedRequest, "url", {
      value: newPath,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (!adaptedRequest.method) {
      adaptedRequest.method = request.method;
    }

    // Make it streamable with EventEmitter
    const emitter = new EventEmitter();
    adaptedRequest.on = emitter.on.bind(emitter);
    adaptedRequest.once = emitter.once.bind(emitter);
    adaptedRequest.emit = emitter.emit.bind(emitter);
    adaptedRequest.removeListener = emitter.removeListener.bind(emitter);
    adaptedRequest.removeAllListeners =
      emitter.removeAllListeners.bind(emitter);
    adaptedRequest.addListener = emitter.addListener.bind(emitter);

    // Call the service to process the request
    this.matchRelayService.processRequest(
      adaptedRequest as any,
      response as any,
      matchId,
    );

    // Then emit body data asynchronously (after listeners are set up)
    setImmediate(() => {
      if (bodyBuffer.length > 0) {
        emitter.emit("data", bodyBuffer);
      }
      emitter.emit("end");
    });
  }
}
