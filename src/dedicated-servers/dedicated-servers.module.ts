import { Module } from "@nestjs/common";
import { DedicatedServersService } from "./dedicated-servers.service";
import { DedicatedServersController } from "./dedicated-servers.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { EncryptionModule } from "src/encryption/encryption.module";

@Module({
  imports: [HasuraModule, EncryptionModule],
  providers: [DedicatedServersService, loggerFactory()],
  controllers: [DedicatedServersController],
})
export class DedicatedServersModule {}
