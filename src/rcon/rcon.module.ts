import { Module } from "@nestjs/common";
import { RconService } from "./rcon.service";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { EncryptionModule } from "../encryption/encryption.module";

@Module({
  imports: [HasuraModule, EncryptionModule],
  exports: [RconService],
  providers: [RconService, loggerFactory()],
})
export class RconModule {}
