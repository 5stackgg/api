import { Module } from "@nestjs/common";
import { CustomPagesController } from "./custom-pages.controller";

@Module({
  controllers: [CustomPagesController],
})
export class CustomPagesModule {}
