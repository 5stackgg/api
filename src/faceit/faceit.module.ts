import { Module } from "@nestjs/common";
import { CacheModule } from "../cache/cache.module";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { FaceitController } from "./faceit.controller";
import { FaceitService } from "./faceit.service";

@Module({
  imports: [CacheModule, HasuraModule],
  controllers: [FaceitController],
  providers: [loggerFactory(), FaceitService],
  exports: [FaceitService],
})
export class FaceitModule {}
