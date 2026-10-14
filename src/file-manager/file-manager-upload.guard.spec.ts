import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { FileManagerUploadGuard } from "./file-manager-upload.guard";

describe("FileManagerUploadGuard", () => {
  const guard = new FileManagerUploadGuard();

  const context = (
    role: string | undefined,
    headers: Record<string, string> = { "x-requested-with": "XMLHttpRequest" },
  ) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          user: role ? { steam_id: "76561198000000001", role } : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;

  it("lets an administrator's upload from the panel through", () => {
    expect(guard.canActivate(context("administrator"))).toBe(true);
  });

  it.each(["user", "moderator", "match_organizer", "tournament_organizer"])(
    "refuses a %s",
    (role) => {
      expect(() => guard.canActivate(context(role))).toThrow(
        ForbiddenException,
      );
    },
  );

  it("refuses a request without a session", () => {
    expect(() => guard.canActivate(context(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it("refuses an administrator's cookie sent by a cross-site form", () => {
    expect(() => guard.canActivate(context("administrator", {}))).toThrow(
      ForbiddenException,
    );
  });
});
