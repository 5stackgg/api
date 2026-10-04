import { Module } from "@nestjs/common";
import { CacheModule } from "src/cache/cache.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { SiteContentController } from "./site-content.controller";
import { SiteContentService } from "./site-content.service";

@Module({
  imports: [CacheModule, PostgresModule],
  controllers: [SiteContentController],
  providers: [SiteContentService],
})
export class SiteContentModule {}
