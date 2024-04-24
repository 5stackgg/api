import { Module } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { TypeSenseController } from "./type-sense.controller";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  imports: [HasuraModule],
  exports: [TypeSenseService],
  providers: [TypeSenseService],
  controllers: [TypeSenseController],
})
export class TypeSenseModule {}
