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
    return `http://${nodeIP}:8585/file-operations/${endpoint}`;
  }

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

      return await response.json();
    } catch (error) {
      this.logger.error(`Error uploading file to ${url}`, error);
      throw error;
    }
  }
}
