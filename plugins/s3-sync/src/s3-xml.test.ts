import { describe, expect, it } from "vitest";
import { parseErrorBody, parseListObjects } from "./s3-xml";

describe("parseListObjects", () => {
  it("reads keys, unquoted ETags and the continuation token", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>p/devices/</Prefix>
<IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>
<Contents><Key>p/devices/a.b64</Key><LastModified>2026-09-17T00:00:00.000Z</LastModified><ETag>&quot;e1&quot;</ETag><Size>3</Size></Contents>
<Contents><Key>p/devices/a &amp; b.json</Key><ETag>"e2"</ETag></Contents>
</ListBucketResult>`;
    expect(parseListObjects(xml)).toEqual({
      objects: [
        { key: "p/devices/a.b64", etag: "e1", lastModified: "2026-09-17T00:00:00.000Z", size: "3" },
        { key: "p/devices/a & b.json", etag: "e2", lastModified: "", size: "" },
      ],
      truncated: true,
      nextToken: "tok&1",
    });
  });

  it("handles an empty listing", () => {
    expect(parseListObjects("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      objects: [],
      truncated: false,
      nextToken: null,
    });
  });
});

describe("parseErrorBody", () => {
  it("strips the host's HTTP prefix", () => {
    expect(parseErrorBody("HTTP 403: <Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>")).toEqual({
      code: "AccessDenied",
      message: "Access Denied",
    });
  });
  it("tolerates a truncated or empty body", () => {
    expect(parseErrorBody("HTTP 404: <Error><Code>NoSuchKey</Code><Mess")).toEqual({ code: "NoSuchKey", message: null });
    expect(parseErrorBody("")).toEqual({ code: null, message: null });
  });
});
