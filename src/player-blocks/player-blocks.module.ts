import { Module } from "@nestjs/common";
import { PostgresModule } from "src/postgres/postgres.module";
import { PlayerBlocksService } from "./player-blocks.service";

@Module({
  imports: [PostgresModule],
  providers: [PlayerBlocksService],
  exports: [PlayerBlocksService],
})
export class PlayerBlocksModule {}
