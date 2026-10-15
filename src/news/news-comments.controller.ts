import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { NewsCommentsService } from "./news-comments.service";

@Controller("news-comments")
export class NewsCommentsController {
  constructor(private readonly comments: NewsCommentsService) {}

  @HasuraAction()
  public async postNewsComment(data: {
    article_id: string;
    parent_id?: string | null;
    body: string;
    user?: User;
  }) {
    return await this.comments.post(data.user, {
      article_id: data.article_id,
      parent_id: data.parent_id,
      body: data.body,
    });
  }

  @HasuraAction()
  public async editNewsComment(data: { id: string; body: string; user?: User }) {
    return await this.comments.edit(data.user, { id: data.id, body: data.body });
  }

  @HasuraAction()
  public async deleteNewsComment(data: { id: string; user?: User }) {
    return await this.comments.remove(data.user, { id: data.id });
  }

  @HasuraAction()
  public async toggleNewsCommentVote(data: { id: string; user?: User }) {
    return await this.comments.toggleVote(data.user, { id: data.id });
  }

  @HasuraAction()
  public async setNewsCommentHidden(data: {
    id: string;
    hidden: boolean;
    reason?: string | null;
    user?: User;
  }) {
    return await this.comments.setHidden(data.user, {
      id: data.id,
      hidden: data.hidden,
      reason: data.reason,
    });
  }
}
