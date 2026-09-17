export function describeError(err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).replace(/^[a-z0-9-]+:\s*/, "");
  return message.charAt(0).toUpperCase() + message.slice(1);
}
