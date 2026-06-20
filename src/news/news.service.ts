import fetch from "node-fetch";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemService } from "src/system/system.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";

interface ScrapedArticle {
  source: string;
  issueNumber: number | null;
  slug: string | null;
  url: string;
  title: string;
  teaser: string | null;
  contentHtml: string | null;
  coverImageUrl: string | null;
  author: string | null;
  publishedAt: Date | null;
}

@Injectable()
export class NewsService {
  private static readonly SOURCE = "tldr";
  private static readonly BASE_URL = "https://readtldr.gg";
  private static readonly ARCHIVE_PATH = "/csgo-archive";
  private static readonly MAX_ARTICLES = 12;
  private static readonly FETCH_TIMEOUT_MS = 15_000;
  private static readonly MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  private static readonly ALLOWED_HOSTS = [
    "readtldr.gg",
    "web.archive.org",
    "website-files.com",
  ];
  private static readonly USER_AGENT =
    "5stack-news-bot/1.0 (+https://5stack.gg; caches readtldr.gg CS news with attribution)";

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly system: SystemService,
  ) {}

  public async scrape(force = false): Promise<void> {
    const enabled = await this.system.getSetting(
      SystemSettingName.TldrNewsEnabled,
      false,
    );

    if (!enabled) {
      return;
    }

    const links = await this.discoverArticleLinks();

    if (links.length === 0) {
      this.logger.warn("[tldr-news] no article links discovered");
      return;
    }

    const newLinks = force ? links : await this.filterUncachedLinks(links);

    if (newLinks.length === 0) {
      return;
    }

    this.logger.log(`[tldr-news] scraping ${newLinks.length} new article(s)`);

    let saved = 0;
    for (const url of newLinks) {
      try {
        const article = await this.scrapeArticle(url);
        if (article) {
          await this.upsertArticle(article);
          saved++;
        }
      } catch (error) {
        this.logger.warn(`[tldr-news] failed to scrape ${url}`, error);
      }
    }

    this.logger.log(`[tldr-news] cached ${saved} article(s)`);
  }

  private async discoverArticleLinks(): Promise<string[]> {
    const html = await this.fetchHtml(
      `${NewsService.BASE_URL}${NewsService.ARCHIVE_PATH}`,
    );

    if (!html) {
      return [];
    }

    return this.extractArticleLinks(html).slice(0, NewsService.MAX_ARTICLES);
  }

  private extractArticleLinks(html: string): string[] {
    const $ = cheerio.load(html);
    const links = new Set<string>();

    $(`a[href*="${NewsService.ARCHIVE_PATH}/"]`).each((_, el) => {
      const href = $(el).attr("href");
      if (!href) {
        return;
      }

      const absolute = this.absoluteUrl(href);
      if (/\/csgo-archive\/\d+-/.test(absolute)) {
        links.add(absolute.split("?")[0].split("#")[0]);
      }
    });

    return Array.from(links);
  }

  private async filterUncachedLinks(links: string[]): Promise<string[]> {
    const existing = await this.postgres.query<
      Array<{ url: string; content_html: string | null }>
    >(
      `SELECT url, content_html FROM public.news_articles WHERE url = ANY($1::text[])`,
      [links],
    );

    const settled = new Set(
      existing
        .filter((row) => (row.content_html ?? "").trim().length > 0)
        .map((row) => row.url),
    );
    return links.filter((url) => !settled.has(url));
  }

  private async scrapeArticle(url: string): Promise<ScrapedArticle | null> {
    const html = await this.fetchHtml(url);
    if (!html) {
      return null;
    }

    const $ = cheerio.load(html);

    const meta = (property: string) =>
      $(`meta[property="${property}"]`).attr("content") ||
      $(`meta[name="${property}"]`).attr("content") ||
      null;

    const { issueNumber, slug } = this.parseIssueAndSlug(url);

    const title =
      this.cleanText(meta("og:title")) ||
      this.cleanText($("h1").first().text()) ||
      this.cleanText($("title").text()) ||
      `Issue #${issueNumber ?? ""}`.trim();

    const teaser =
      this.cleanText(meta("og:description")) ||
      this.cleanText(meta("description")) ||
      this.cleanText($(".archive-intro").first().text());

    const coverImageUrl = this.sanitizeImageUrl(meta("og:image"));
    const author = this.cleanText(meta("author") || meta("article:author"));

    const publishedRaw =
      meta("article:published_time") ||
      meta("article:modified_time") ||
      $("time[datetime]").first().attr("datetime") ||
      null;
    const publishedAt = this.parseDate(publishedRaw);

    const contentHtml = await this.fetchArticleBody(html);
    if (!contentHtml) {
      this.logger.warn(
        `[tldr-news] not storing ${url}: full article body unavailable`,
      );
      return null;
    }

    return {
      source: NewsService.SOURCE,
      issueNumber,
      slug,
      url,
      title,
      teaser,
      contentHtml,
      coverImageUrl,
      author,
      publishedAt,
    };
  }

  private async fetchArticleBody(pageHtml: string): Promise<string | null> {
    const webArchiveUrl = this.extractWebArchiveUrl(pageHtml);

    if (!webArchiveUrl) {
      this.logger.warn(
        "[tldr-news] no article body url found on page; skipping (only the teaser is available)",
      );
      return null;
    }

    if (!this.isAllowedUrl(webArchiveUrl)) {
      const host = this.hostnameOf(webArchiveUrl);
      this.logger.warn(
        `[tldr-news] article body hosted on non-allowlisted host "${host}" (${webArchiveUrl}); add it to ALLOWED_HOSTS to cache the full article`,
      );
      return null;
    }

    const raw = await this.fetchHtml(webArchiveUrl);
    const cleaned = raw ? this.cleanHtml(raw, webArchiveUrl) : "";
    if (cleaned.length === 0) {
      this.logger.warn(
        `[tldr-news] failed to fetch full article body from ${webArchiveUrl}; skipping`,
      );
      return null;
    }

    return cleaned;
  }

  private extractWebArchiveUrl(pageHtml: string): string | null {
    const match = pageHtml.match(/webArchivePath\s*=\s*["']([^"']+)["']/);
    const url = match?.[1]?.trim();
    return url && url.length > 0 ? url : null;
  }

  private cleanHtml(rawHtml: string, baseUrl: string): string {
    const $ = cheerio.load(rawHtml, null, false);

    $("a[href^='/']").each((_, el) => {
      $(el).attr("href", this.absoluteUrl($(el).attr("href") as string, baseUrl));
    });
    $("img[src^='/']").each((_, el) => {
      $(el).attr("src", this.absoluteUrl($(el).attr("src") as string, baseUrl));
    });

    const sanitized = sanitizeHtml($.html() || "", {
      allowedTags: [
        "p",
        "br",
        "hr",
        "a",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "strong",
        "b",
        "em",
        "i",
        "u",
        "s",
        "span",
        "div",
        "code",
        "pre",
        "img",
        "figure",
        "figcaption",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
      ],
      allowedAttributes: {
        "*": [
          "style",
          "class",
          "align",
          "valign",
          "width",
          "height",
          "bgcolor",
          "border",
          "cellpadding",
          "cellspacing",
          "role",
        ],
        a: ["href", "title", "rel", "target"],
        img: ["src", "alt", "title", "width", "height"],
      },
      allowedSchemes: ["http", "https"],
      allowedSchemesByTag: {
        a: ["http", "https"],
        img: ["http", "https"],
      },
      allowProtocolRelative: false,
      transformTags: {
        a: sanitizeHtml.simpleTransform("a", {
          rel: "noopener noreferrer",
          target: "_blank",
        }),
      },
    });

    return sanitized.trim();
  }

  private async upsertArticle(article: ScrapedArticle): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.news_articles
        (source, issue_number, slug, url, title, teaser, content_html, cover_image_url, author, published_at, scraped_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, now()), now(), now())
       ON CONFLICT (url) DO UPDATE SET
        title = EXCLUDED.title,
        teaser = EXCLUDED.teaser,
        content_html = EXCLUDED.content_html,
        cover_image_url = EXCLUDED.cover_image_url,
        author = EXCLUDED.author,
        published_at = EXCLUDED.published_at,
        scraped_at = now(),
        updated_at = now()
       WHERE coalesce(trim(public.news_articles.content_html), '') = ''`,
      [
        article.source,
        article.issueNumber,
        article.slug,
        article.url,
        article.title,
        article.teaser,
        article.contentHtml,
        article.coverImageUrl,
        article.author,
        article.publishedAt,
      ] as Array<string | number | Date>,
    );
  }

  private async fetchHtml(url: string): Promise<string | null> {
    if (!this.isAllowedUrl(url)) {
      this.logger.warn(`[tldr-news] refusing to fetch disallowed url ${url}`);
      return null;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": NewsService.USER_AGENT,
            Accept: "text/html",
            "Accept-Encoding": "identity",
          },
          redirect: "manual",
          size: NewsService.MAX_RESPONSE_BYTES,
          signal: AbortSignal.timeout(NewsService.FETCH_TIMEOUT_MS),
        });

        if (response.status >= 300 && response.status < 400) {
          this.logger.warn(
            `[tldr-news] refusing to follow redirect ${response.status} for ${url}`,
          );
          return null;
        }

        if (!response.ok) {
          this.logger.warn(`[tldr-news] http ${response.status} for ${url}`);
          return null;
        }

        return await response.text();
      } catch (error) {
        if (attempt === 3) {
          this.logger.warn(
            `[tldr-news] fetch failed for ${url} after ${attempt} attempts`,
            error,
          );
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }

    return null;
  }

  private absoluteUrl(
    href: string,
    baseUrl: string = NewsService.BASE_URL,
  ): string {
    const trimmed = href.trim();

    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return new URL(trimmed).toString();
      } catch {
        return baseUrl;
      }
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
      return baseUrl;
    }

    try {
      return new URL(trimmed, `${baseUrl}/`).toString();
    } catch {
      return baseUrl;
    }
  }

  private sanitizeImageUrl(url: string | null | undefined): string | null {
    if (!url) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString();
  }

  private hostnameOf(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "unknown";
    }
  }

  private isAllowedUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    return NewsService.ALLOWED_HOSTS.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    );
  }

  private parseIssueAndSlug(url: string): {
    issueNumber: number | null;
    slug: string | null;
  } {
    const match = url.match(/\/csgo-archive\/(\d+)-([^/?#]+)/);
    if (!match) {
      return { issueNumber: null, slug: null };
    }
    return { issueNumber: Number(match[1]), slug: match[2] };
  }

  private parseDate(value: string | null): Date | null {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  private cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
