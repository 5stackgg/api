import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { NewsCommentsController } from "./news-comments.controller";

const METADATA = join(__dirname, "../../hasura/metadata");

const actions = yaml.load(
  readFileSync(join(METADATA, "actions.yaml"), "utf8"),
) as {
  actions: Array<{
    name: string;
    definition: { kind: string; handler: string };
    permissions?: Array<{ role: string }>;
  }>;
  custom_types: { objects: Array<{ name: string }> };
};

const graphql = readFileSync(join(METADATA, "actions.graphql"), "utf8");

const READERS_WHO_SIGN_IN = [
  "administrator",
  "tournament_organizer",
  "match_organizer",
  "moderator",
  "streamer",
  "verified_user",
  "user",
];

const STAFF = [
  "administrator",
  "tournament_organizer",
  "match_organizer",
  "moderator",
];

const action = (name: string) =>
  actions.actions.find((entry) => entry.name === name);

const roles = (name: string) =>
  (action(name)?.permissions ?? []).map((entry) => entry.role).sort();

describe("news comment actions", () => {
  const user = {
    steam_id: "76561198000000001",
    name: "kappa",
    role: "verified_user",
  } as any;

  let service: Record<string, jest.Mock>;
  let controller: NewsCommentsController;

  beforeEach(() => {
    service = {
      post: jest.fn().mockResolvedValue({ id: "c1", parent_id: null }),
      edit: jest.fn().mockResolvedValue({ id: "c1", parent_id: null }),
      remove: jest.fn().mockResolvedValue({ success: true }),
      toggleVote: jest
        .fn()
        .mockResolvedValue({ comment_id: "c1", vote_count: 1, voted: true }),
      setHidden: jest.fn().mockResolvedValue({ id: "c1", parent_id: null }),
    };
    controller = new NewsCommentsController(service as any);
  });

  it("declares every action against the API's hook, with its output types", () => {
    for (const name of [
      "postNewsComment",
      "editNewsComment",
      "deleteNewsComment",
      "toggleNewsCommentVote",
      "setNewsCommentHidden",
    ]) {
      expect(action(name)?.definition).toEqual(
        expect.objectContaining({
          kind: "synchronous",
          handler: "{{HASURA_GRAPHQL_ACTIONS_HOOK}}",
        }),
      );
      expect(graphql).toContain(`  ${name}(`);
      expect(typeof (controller as any)[name]).toBe("function");
    }

    const objects = actions.custom_types.objects.map((entry) => entry.name);
    expect(objects).toEqual(
      expect.arrayContaining(["NewsCommentOutput", "NewsCommentVoteOutput"]),
    );
  });

  it("offers writing to every signed-in role and hiding to staff alone", () => {
    for (const name of [
      "postNewsComment",
      "editNewsComment",
      "deleteNewsComment",
      "toggleNewsCommentVote",
    ]) {
      expect(roles(name)).toEqual([...READERS_WHO_SIGN_IN].sort());
    }
    expect(roles("setNewsCommentHidden")).toEqual([...STAFF].sort());
  });

  it("hands the signed-in player and their input to the service", async () => {
    await expect(
      controller.postNewsComment({
        article_id: "a1",
        parent_id: "p1",
        body: "hi",
        user,
      }),
    ).resolves.toEqual({ id: "c1", parent_id: null });
    expect(service.post).toHaveBeenCalledWith(user, {
      article_id: "a1",
      parent_id: "p1",
      body: "hi",
    });

    await controller.editNewsComment({ id: "c1", body: "edit", user });
    expect(service.edit).toHaveBeenCalledWith(user, { id: "c1", body: "edit" });

    await controller.deleteNewsComment({ id: "c1", user });
    expect(service.remove).toHaveBeenCalledWith(user, { id: "c1" });

    await controller.toggleNewsCommentVote({ id: "c1", user });
    expect(service.toggleVote).toHaveBeenCalledWith(user, { id: "c1" });

    await controller.setNewsCommentHidden({
      id: "c1",
      hidden: true,
      reason: "spam",
      user,
    });
    expect(service.setHidden).toHaveBeenCalledWith(user, {
      id: "c1",
      hidden: true,
      reason: "spam",
    });
  });
});
