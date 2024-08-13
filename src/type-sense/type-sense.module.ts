import { Module } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { TypeSenseController } from "./type-sense.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import {CacheModule} from "../cache/cache.module";

@Module({
  imports: [HasuraModule, CacheModule],
  exports: [TypeSenseService],
  providers: [TypeSenseService, loggerFactory()],
  controllers: [TypeSenseController],
})
export class TypeSenseModule {}
