import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";

@Injectable()
export class FileManagerService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {}

  /**
   * Verify user is an administrator
   */
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

  /**
   * Get node IP address from database
   */
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

  /**
   * Build base path for server files or custom plugins
   */
  private getBasePath(serverId?: string): string {
    if (serverId) {
      return `/servers/${serverId}`;
    }
    return `/custom-plugins`;
  }

  /**
   * Build URL for node connector endpoint
   */
  private getNodeConnectorURL(nodeIP: string, endpoint: string): string {
    return `http://${nodeIP}:8585/file-operations/${endpoint}`;
  }

  /**
   * Make HTTP request to node connector
   */
  private async requestNodeConnector(
    nodeIP: string,
    endpoint: string,
    options: RequestInit = {},
  ): Promise<any> {
    const url = this.getNodeConnectorURL(nodeIP, endpoint);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new BadRequestException(
          error.message || `Node connector error: ${response.statusText}`,
        );
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`Error calling node connector at ${url}`, error);
      throw error;
    }
  }

  /**
   * Log file operation for real-time subscriptions
   */
  async logFileOperation(
    nodeId: string,
    serverId: string | null,
    operation: string,
    path: string,
    details?: Record<string, any>,
  ): Promise<void> {
    try {
      // TODO: Re-enable after running GraphQL codegen
      // await this.hasura.mutation({
      //   insert_file_operations_log_one: {
      //     __args: {
      //       object: {
      //         node_id: nodeId,
      //         server_id: serverId,
      //         operation,
      //         path,
      //         details: details || {},
      //       },
      //     },
      //     id: true,
      //   },
      // });
      this.logger.log(
        `File operation: ${operation} on ${path} (node: ${nodeId}, server: ${serverId})`,
      );
    } catch (error) {
      this.logger.error("Failed to log file operation", error);
    }
  }

  /**
   * List files in a directory
   */
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

  /**
   * Read file content
   */
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

  /**
   * Create directory
   */
  async createDirectory(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    dirPath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const result = await this.requestNodeConnector(nodeIP, "create-directory", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        dirPath,
      }),
    });

    await this.logFileOperation(nodeId, serverId || null, "create", dirPath);
    return result;
  }

  /**
   * Delete file or directory
   */
  async deleteItem(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    path: string,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const result = await this.requestNodeConnector(nodeIP, "delete", {
      method: "DELETE",
      body: JSON.stringify({
        basePath,
        path,
      }),
    });

    await this.logFileOperation(nodeId, serverId || null, "delete", path);
    return result;
  }

  /**
   * Move file or directory
   */
  async moveItem(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    sourcePath: string,
    destPath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const result = await this.requestNodeConnector(nodeIP, "move", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        sourcePath,
        destPath,
      }),
    });

    await this.logFileOperation(nodeId, serverId || null, "move", sourcePath, {
      destPath,
    });
    return result;
  }

  /**
   * Rename file or directory
   */
  async renameItem(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    oldPath: string,
    newPath: string,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const result = await this.requestNodeConnector(nodeIP, "rename", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        oldPath,
        newPath,
      }),
    });

    await this.logFileOperation(nodeId, serverId || null, "rename", oldPath, {
      newPath,
    });
    return result;
  }

  /**
   * Write text content to a file
   */
  async writeFile(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    filePath: string,
    content: string,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const result = await this.requestNodeConnector(nodeIP, "write", {
      method: "POST",
      body: JSON.stringify({
        basePath,
        filePath,
        content,
      }),
    });

    await this.logFileOperation(nodeId, serverId || null, "write", filePath);
    return result;
  }

  /**
   * Upload file to node connector
   */
  async uploadFile(
    userId: string,
    nodeId: string,
    serverId: string | undefined,
    filePath: string,
    buffer: Buffer,
  ) {
    await this.verifyAdminPermissions(userId);
    const nodeIP = await this.getNodeIP(nodeId);
    const basePath = this.getBasePath(serverId);

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)]);
    formData.append("file", blob);
    formData.append("basePath", basePath);
    formData.append("filePath", filePath);

    const url = this.getNodeConnectorURL(nodeIP, "upload");

    try {
      const response = await fetch(url, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new BadRequestException(
          error.message || `Upload failed: ${response.statusText}`,
        );
      }

      await this.logFileOperation(nodeId, serverId || null, "upload", filePath);
      return await response.json();
    } catch (error) {
      this.logger.error(`Error uploading file to ${url}`, error);
      throw error;
    }
  }
}
