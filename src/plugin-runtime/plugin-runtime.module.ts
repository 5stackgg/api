import { Module } from "@nestjs/common";
import { PluginRuntimeService } from "./plugin-runtime.service";
import { PostgresModule } from "src/postgres/postgres.module";

@Module({
  imports: [PostgresModule],
  providers: [PluginRuntimeService],
  exports: [PluginRuntimeService],
})
export class PluginRuntimeModule {}
