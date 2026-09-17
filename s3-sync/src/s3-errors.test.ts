import { describe, expect, it } from "vitest";
import { toStoreError } from "./s3-errors";

const body = (code: string) => `HTTP 403: <Error><Code>${code}</Code><Message>m</Message></Error>`;

describe("toStoreError", () => {
  it.each(["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied"])("%s is auth", (code) =>
    expect(toStoreError(403, body(code)).kind).toBe("auth"),
  );
  it("a bare 403 is auth", () => expect(toStoreError(403, "").kind).toBe("auth"));
  it("clock skew is clock, not auth", () => expect(toStoreError(403, body("RequestTimeTooSkewed")).kind).toBe("clock"));
  it("missing bucket is not_found", () => expect(toStoreError(404, body("NoSuchBucket")).kind).toBe("not_found"));
  it.each([
    [400, "AuthorizationHeaderMalformed"],
    [301, "PermanentRedirect"],
  ])("%i %s is not_found with a region/endpoint message", (status, code) => {
    const err = toStoreError(status, `HTTP ${status}: <Error><Code>${code}</Code><Message>m</Message></Error>`);
    expect(err).toMatchObject({ kind: "not_found", status });
    expect(err.message).toMatch(/region/);
    expect(err.message).toMatch(/endpoint/);
  });
  it.each(["AllAccessDisabled", "AccountProblem"])("%s is auth", (code) => expect(toStoreError(403, body(code)).kind).toBe("auth"));
  it("clock skew still wins over a 400", () => expect(toStoreError(400, body("RequestTimeTooSkewed")).kind).toBe("clock"));
  it.each([412, 409])("%i is conflict", (s) => expect(toStoreError(s, "").kind).toBe("conflict"));
  it("anything else keeps the provider code", () => {
    const err = toStoreError(500, "HTTP 500: <Error><Code>InternalError</Code><Message>oops</Message></Error>");
    expect(err).toMatchObject({ kind: "other", message: "InternalError: oops", status: 500 });
  });
});
