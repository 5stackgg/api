import { Module } from "@nestjs/common";
import { PluginsController } from "./plugins.controller";

@Module({
  controllers: [PluginsController],
})
export class PluginsModule {}
