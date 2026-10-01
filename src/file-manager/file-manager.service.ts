import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import * as http from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";

export type ServerDirectorySummary = {
  exists: boolean;
  entries: number;
  bytes: number;
  archiveBytes: number;
  skipped: Array<string>;
};

@Injectable()
export class FileManagerService {
  private static readonly CONNECTOR_PORT = 8585;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
  ) {}

  private async verifyAdminPermissions(userId: string): Promise<void> {
    if (!userId) {
      throw new ForbiddenException("User not authenticated");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: userId,
        },
        role: true,
      },
    });

    if (players_by_pk?.role !== "administrator") {
      this.logger.warn(`Non-admin user ${userId} attempted file operation`);
      throw new ForbiddenException("Administrator access required");
    }
  }

  private async getNodeIP(nodeId: string): Promise<string> {
    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: nodeId,
        },
        node_ip: true,
      },
    });

    if (!game_server_nodes_by_pk?.node_ip) {
      throw new NotFoundException(`Node ${nodeId} not found or offline`);
    }

    return game_server_nodes_by_pk.node_ip;
  }

  private getBasePath(serverId?: string): string {
    if (serverId) {
      return `/servers/${serverId}`;
    }
    return `/custom-plugins`;
  }

  private getNodeConnectorURL(nodeIP: string, endpoint: string): string {
    return `http://${nodeIP}:${FileManagerService.CONNECTOR_PORT}/file-operations/${endpoint}`;
  }

  public static outdatedConnectorMessage(nodeId: string): string {
    return `The node connector on ${nodeId} is out of date. Update it to move servers between nodes.`;
  }

  private async assertServerNotMoving(serverId?: string): Promise<void> {
    if (!serverId) {
      return;
    }

    const rows = await this.postgres.query<Array<unknown>>(
      `SELECT 1 FROM server_migrations
        WHERE server_id = $1
          AND status IN ('Queued', 'Stopping', 'Transferring', 'Finalizing')`,
      [serverId],
    );

    if (rows.length > 0) {
      throw new BadRequestException(
        "This server is being moved to another node. Its files can be changed once the move finishes.",
      );
    }
  }

  // The connector's validation errors come back as an array of strings, and an
  // HttpException built from anything but a string reports itself as "Bad
  // Request Exception" -- the operator is told the request failed and nothing
  // about why. The body is whatever came off the wire, so nothing here can
  // assume the shape. Public because GamePluginsService reaches the same
  // connector behind the same ValidationPipe.
  public static connectorErrorMessage(error: unknown): string {
    const message = (error as { message?: unknown })?.message;

    if (Array.isArray(message)) {
      return message.join(", ");
    }

    if (typeof message === "string") {
      return message;
    }

    if (message === undefined || message === null) {
      return "";
    }

    return JSON.stringify(message);
  }

  private async requestNodeConnector(
    nodeIP: string,
    endpoint: string,
    options: RequestInit = {},
    outdatedMessage?: string,
  ): Promise<any> {
    const url = this.getNodeConnectorURL(nodeIP, endpoint);
    // fetch sets its own multipart Content-Type, boundary and all; naming it
    // here would leave the connector unable to parse the upload.
    const isFormData = options.body instanceof FormData;

    let response: Response;

    try {
      response = await fetch(url, {
        ...options,
        headers: {
          ...(isFormData ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
      });
    } catch (error) {
      this.logger.error(`Error calling node connector at ${url}`, error);
      throw error;
    }

    // Thrown outside the catch above: a rejected file operation is the operator
    // mistyping a path, not the node being unreachable, and logging it at error
    // level with a stack buries the transport failures that are.
    if (response.status === 404 && outdatedMessage) {
      throw new BadRequestException(outdatedMessage);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new BadRequestException(
        FileManagerService.connectorErrorMessage(error) ||
          `Node connector error: ${response.statusText}`,
      );
    }

    return await response.json();
  }

  async listFiles(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    path: string = "",
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const params = new URLSearchParams({
      basePath,
      ...(path && { path }),
    });

    return await this.requestNodeConnector(nodeIP, `list?${params.toString()}`);
  }

  async readFile(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    filePath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const params = new URLSearchParams({
      basePath,
      path: filePath,
    });

    return await this.requestNodeConnector(nodeIP, `read?${params.toString()}`);
  }

  async createDirectory(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    dirPath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    await this.assertServerNotMoving(serverId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    return await this.requestNodeConnector(nodeIP, "create-directory", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        dirPath,
      }),
    });
  }

  async deleteItem(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    path: string,
  ) {
    await this.verifyAdminPermissions(userId);
    await this.assertServerNotMoving(serverId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    return await this.requestNodeConnector(nodeIP, "delete", {
      method: "DELETE",
      body: JSON.stringify({
        basePath,
        path,
      }),
    });
  }

  async moveItem(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    sourcePath: string,
    destPath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    await this.assertServerNotMoving(serverId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    return await this.requestNodeConnector(nodeIP, "move", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        sourcePath,
        destPath,
      }),
    });
  }

  async renameItem(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    oldPath: string,
    newPath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    await this.assertServerNotMoving(serverId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    return await this.requestNodeConnector(nodeIP, "rename", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        oldPath,
        newPath,
      }),
    });
  }

  async writeFile(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    filePath: string,
    content: string,
  ) {
    await this.verifyAdminPermissions(userId);
    await this.assertServerNotMoving(serverId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    return await this.requestNodeConnector(nodeIP, "write", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        filePath,
        content,
      }),
    });
  }

  async uploadFile(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    filePath: string,
    buffer: Buffer,
  ) {
    await this.verifyAdminPermissions(userId);
    await this.assertServerNotMoving(serverId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)]);
    formData.append("file", blob);
    formData.append("basePath", basePath);
    formData.append("filePath", filePath);

    return await this.requestNodeConnector(nodeIP, "upload", {
      method: "POST",
      body: formData,
    });
  }

  public async serverDirectorySize(
    nodeId: string,
    serverId: string,
  ): Promise<ServerDirectorySummary> {
    const nodeIP = await this.getNodeIP(nodeId);

    return await this.requestNodeConnector(
      nodeIP,
      `servers/${serverId}/size`,
      { signal: AbortSignal.timeout(60 * 1000) },
      FileManagerService.outdatedConnectorMessage(nodeId),
    );
  }

  public async deleteServerDirectory(
    nodeId: string,
    serverId: string,
  ): Promise<{ existed: boolean }> {
    const nodeIP = await this.getNodeIP(nodeId);

    return await this.requestNodeConnector(
      nodeIP,
      `servers/${serverId}`,
      { method: "DELETE", signal: AbortSignal.timeout(5 * 60 * 1000) },
      FileManagerService.outdatedConnectorMessage(nodeId),
    );
  }

  // Streams the server's directory from one node's connector straight into
  // the other's. Nothing is buffered here, and plain http is used because
  // fetch's default body and header timeouts would cut off a long transfer.
  public async relayServerDirectory(
    fromNodeId: string,
    toNodeId: string,
    serverId: string,
    options: {
      signal: AbortSignal;
      onProgress: (bytesDone: number, bytesTotal: number) => void;
    },
  ): Promise<{ entries: number; bytes: number }> {
    const [from, to] = await Promise.all([
      this.connectorAddress(fromNodeId),
      this.connectorAddress(toNodeId),
    ]);

    const source = await this.openConnectorStream(
      from,
      `servers/${serverId}/archive`,
      options.signal,
    );

    if (source.statusCode === 404) {
      source.resume();
      throw new BadRequestException(
        FileManagerService.outdatedConnectorMessage(fromNodeId),
      );
    }

    if (source.statusCode !== 200) {
      throw new BadRequestException(
        FileManagerService.connectorErrorMessage(
          await FileManagerService.readJson(source),
        ) || `Unable to read the server files from ${fromNodeId}`,
      );
    }

    const bytesTotal = Number(source.headers["x-5stack-archive-bytes"]) || 0;
    let bytesDone = 0;

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesDone += chunk.length;
        options.onProgress(bytesDone, bytesTotal);
        callback(null, chunk);
      },
    });

    const upload = http.request({
      ...to,
      method: "POST",
      path: `/file-operations/servers/${serverId}/extract`,
      signal: options.signal,
      headers: {
        "content-type": "application/x-tar",
        "x-5stack-expected-entries": source.headers["x-5stack-entries"],
        "x-5stack-expected-bytes": source.headers["x-5stack-bytes"],
      },
    });

    let rejection: string | undefined;

    const response = new Promise<{ status: number; body: any }>(
      (resolve, reject) => {
        upload.once("error", reject);
        upload.once("response", (res) => {
          void FileManagerService.readJson(res).then((body) => {
            const status = res.statusCode ?? 0;

            if (status === 404) {
              rejection = FileManagerService.outdatedConnectorMessage(toNodeId);
            } else if (status >= 300) {
              rejection =
                FileManagerService.connectorErrorMessage(body) ||
                `Unable to write the server files to ${toNodeId}`;
            }

            if (rejection) {
              source.destroy();
              upload.destroy();
            }

            resolve({ status, body });
          }, reject);
        });
      },
    );

    response.catch(() => {});

    try {
      await pipeline(source, counter, upload, { signal: options.signal });
    } catch (error) {
      if (rejection) {
        throw new BadRequestException(rejection);
      }

      throw error;
    }

    const { body } = await response;

    if (rejection) {
      throw new BadRequestException(rejection);
    }

    return { entries: Number(body.entries), bytes: Number(body.bytes) };
  }

  private async connectorAddress(
    nodeId: string,
  ): Promise<{ host: string; port: number }> {
    return {
      host: await this.getNodeIP(nodeId),
      port: FileManagerService.CONNECTOR_PORT,
    };
  }

  private openConnectorStream(
    address: { host: string; port: number },
    endpoint: string,
    signal: AbortSignal,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      http
        .get(
          { ...address, path: `/file-operations/${endpoint}`, signal },
          resolve,
        )
        .once("error", reject);
    });
  }

  private static async readJson(stream: Readable): Promise<any> {
    const chunks: Array<Buffer> = [];

    try {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }

      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }
}
