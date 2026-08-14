import { isAllowedPushEndpoint } from "./push-endpoint";

describe("isAllowedPushEndpoint", () => {
  describe("real push services", () => {
    it.each([
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://fcm.googleapis.com/wp/abc123",
      "https://android.googleapis.com/gcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc123",
      "https://autopush.stage.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QRSTUV",
      "https://sin.notify.windows.com/w/?token=abc",
    ])("accepts %s", (endpoint) => {
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    });
  });

  describe("the SSRF this exists to stop", () => {
    it.each([
      "http://10.0.0.5:8080/internal",
      "https://10.0.0.5/internal",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://timescaledb.5stack.svc.cluster.local/",
      "https://hasura:8080/v1/graphql",
    ])("rejects %s", (endpoint) => {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    });
  });

  describe("attempts to walk around the allowlist", () => {
    it("rejects a lookalike domain that merely ends with the brand", () => {
      // endsWith on a suffix that does not start with "." would let this pass.
      expect(
        isAllowedPushEndpoint("https://push.apple.com.attacker.test/x"),
      ).toBe(false);
      expect(
        isAllowedPushEndpoint("https://notfcm.googleapis.com/fcm/send/x"),
      ).toBe(false);
    });

    it("rejects an allowed host smuggled into userinfo", () => {
      // The real host here is attacker.test; the browser-style URL parser is
      // what makes this unambiguous.
      expect(
        isAllowedPushEndpoint("https://fcm.googleapis.com@attacker.test/x"),
      ).toBe(false);
    });

    it("rejects credentials even on an allowed host", () => {
      expect(
        isAllowedPushEndpoint("https://user:pass@fcm.googleapis.com/fcm/send/x"),
      ).toBe(false);
    });

    it("rejects plain http on an allowed host", () => {
      expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(
        false,
      );
    });

    it("ignores case in the hostname", () => {
      expect(isAllowedPushEndpoint("https://FCM.GoogleAPIs.com/fcm/send/x")).toBe(
        true,
      );
    });

    it("rejects other schemes entirely", () => {
      expect(isAllowedPushEndpoint("file:///etc/passwd")).toBe(false);
      expect(isAllowedPushEndpoint("gopher://fcm.googleapis.com/")).toBe(false);
    });
  });

  describe("malformed input", () => {
    it.each([["" as unknown], [null], [undefined], [{}], [42], ["not a url"]])(
      "rejects %p",
      (endpoint) => {
        expect(isAllowedPushEndpoint(endpoint)).toBe(false);
      },
    );
  });
});
