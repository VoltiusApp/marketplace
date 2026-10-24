export type ListPage = { objects: { key: string; etag: string; lastModified: string; size: string }[]; truncated: boolean; nextToken: string | null };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const ESCAPES = Object.fromEntries(Object.entries(ENTITIES).map(([name, ch]) => [ch, `&${name};`]));

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e.toLowerCase()],
  );
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}

export function parseListObjects(xml: string): ListPage {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
    key: tag(c, "Key") ?? "",
    etag: (tag(c, "ETag") ?? "").replace(/^"|"$/g, ""),
    lastModified: tag(c, "LastModified") ?? "",
    size: tag(c, "Size") ?? "",
  }));
  return { objects, truncated: tag(xml, "IsTruncated") === "true", nextToken: tag(xml, "NextContinuationToken") };
}

export function parseErrorBody(body: string): { code: string | null; message: string | null } {
  const xml = body.replace(/^HTTP \d{3}: /, "");
  return { code: tag(xml, "Code"), message: tag(xml, "Message") };
}

export function deleteErrors(xml: string): string[] {
  return [...xml.matchAll(/<Error>[\s\S]*?<\/Error>/g)].map(([e]) => e);
}
