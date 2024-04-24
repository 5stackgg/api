import { Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";

@Module({
  exports: [EncryptionService],
  providers: [EncryptionService],
})
export class EncryptionModule {}
