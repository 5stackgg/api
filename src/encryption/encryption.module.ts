import { Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  exports: [EncryptionService],
  providers: [EncryptionService, loggerFactory()],
})
export class EncryptionModule {}
