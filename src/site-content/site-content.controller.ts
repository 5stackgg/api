import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { SiteContentService } from "./site-content.service";

@Controller("site-content")
export class SiteContentController {
  constructor(private readonly siteContentService: SiteContentService) {}

  @HasuraAction()
  public async siteContent() {
    return await this.siteContentService.get();
  }
}
