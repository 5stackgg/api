import {
  Controller,
  Post,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { FileManagerService } from "./file-manager.service";
import { HasuraAction } from "../hasura/hasura.controller";

@Controller("file-manager")
export class FileManagerController {
  constructor(
    private readonly fileManagerService: FileManagerService,
  ) {}

  @HasuraAction()
  async listServerFiles(data: {
    node_id: string;
    server_id?: string;
    path?: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.listFiles(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.path,
    );
  }

  @HasuraAction()
  async readServerFile(data: {
    node_id: string;
    server_id?: string;
    file_path: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.readFile(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.file_path,
    );
  }

  @HasuraAction()
  async createServerDirectory(data: {
    node_id: string;
    server_id?: string;
    dir_path: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.createDirectory(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.dir_path,
    );
  }

  @HasuraAction()
  async deleteServerItem(data: {
    node_id: string;
    server_id?: string;
    path: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.deleteItem(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.path,
    );
  }

  @HasuraAction()
  async moveServerItem(data: {
    node_id: string;
    server_id?: string;
    source_path: string;
    dest_path: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.moveItem(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.source_path,
      data.dest_path,
    );
  }

  @HasuraAction()
  async renameServerItem(data: {
    node_id: string;
    server_id?: string;
    old_path: string;
    new_path: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.renameItem(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.old_path,
      data.new_path,
    );
  }

  @HasuraAction()
  async writeServerFile(data: {
    node_id: string;
    server_id?: string;
    file_path: string;
    content: string;
    user: { steam_id: string };
  }) {
    return await this.fileManagerService.writeFile(
      data.user.steam_id,
      data.node_id,
      data.server_id,
      data.file_path,
      data.content,
    );
  }

  @Post("upload/:nodeId/:serverId")
  @UseInterceptors(FileInterceptor("file"))
  async uploadFileToServer(
    @Param("nodeId") nodeId: string,
    @Param("serverId") serverId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 100 * 1024 * 1024 }), // 100MB
        ],
      }),
    )
    file: Express.Multer.File,
    @Body("filePath") filePath: string,
    @Body("userId") userId: string,
  ) {
    return await this.fileManagerService.uploadFile(
      userId,
      nodeId,
      serverId,
      filePath,
      file.buffer,
    );
  }

  @Post("upload/:nodeId")
  @UseInterceptors(FileInterceptor("file"))
  async uploadFileToCustomPlugins(
    @Param("nodeId") nodeId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 100 * 1024 * 1024 }), // 100MB
        ],
      }),
    )
    file: Express.Multer.File,
    @Body("filePath") filePath: string,
    @Body("userId") userId: string,
  ) {
    return await this.fileManagerService.uploadFile(
      userId,
      nodeId,
      undefined,
      filePath,
      file.buffer,
    );
  }
}
