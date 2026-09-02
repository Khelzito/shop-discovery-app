/**
 * Absolute http(s) check, with no dependency of any kind.
 *
 * Kept separate from lib/url.ts, which pulls in expo-web-browser: this
 * predicate runs inside the shop mapper, which is plain data code and is
 * covered by the Node test suite.
 */
const HTTP_URL = /^https?:\/\/\S+$/i;

export function isHttpUrl(value: string | null | undefined): boolean {
  return typeof value === 'string' && HTTP_URL.test(value.trim());
}
