import { Injectable } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { PostgresService } from "src/postgres/postgres.service";

export interface SiteContent {
  tournaments: boolean;
  events: boolean;
  news: boolean;
  highlights: boolean;
}

// Whether each view-only section has anything a guest can see, so the web nav
// can hide sections that would only show an empty state. Checked against the
// guest select filters, and cached briefly: sections rarely go from something
// back to nothing.
@Injectable()
export class SiteContentService {
  private static readonly CACHE_KEY = "site-content";
  private static readonly CACHE_SECONDS = 60;

  constructor(
    private readonly cache: CacheService,
    private readonly postgres: PostgresService,
  ) {}

  public async get(): Promise<SiteContent> {
    return await this.cache.remember<SiteContent>(
      SiteContentService.CACHE_KEY,
      () => this.load(),
      SiteContentService.CACHE_SECONDS,
    );
  }

  private async load(): Promise<SiteContent> {
    const [row] = await this.postgres.query<Array<SiteContent>>(`
      select
        exists(
          select 1 from tournaments t
          where not exists (
            select 1 from league_season_divisions d where d.tournament_id = t.id
          )
        ) as tournaments,
        exists(select 1 from events where visibility = 'Public') as events,
        exists(select 1 from news_articles where status = 'published') as news,
        exists(select 1 from match_clips where visibility = 'public') as highlights
    `);
    return row;
  }
}
