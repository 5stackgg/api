import { Module, Logger } from "@nestjs/common";
import { FileManagerService } from "./file-manager.service";
import { FileManagerController } from "./file-manager.controller";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  imports: [HasuraModule],
  providers: [FileManagerService, Logger],
  controllers: [FileManagerController],
  exports: [FileManagerService],
})
export class FileManagerModule {}
