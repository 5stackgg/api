import { Module } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { TypeSenseController } from "./type-sense.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule],
  exports: [TypeSenseService],
  providers: [TypeSenseService, loggerFactory()],
  controllers: [TypeSenseController],
})
export class TypeSenseModule {}
