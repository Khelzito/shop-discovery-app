import * as WebBrowser from 'expo-web-browser';

import { isHttpUrl } from '@/lib/http-url';

/**
 * Only absolute http(s) URLs may be opened. External URLs are validated
 * before use so a malformed or non-web scheme from the catalogue can never
 * reach the browser (docs/MASTER_SPEC.md §14).
 *
 * The predicate itself lives in lib/http-url.ts so the shop mapper can share
 * it without pulling in expo-web-browser.
 */
export function isExternalHttpUrl(value: string): boolean {
  return isHttpUrl(value);
}

/**
 * Opens a merchant website in an in-app browser, keeping the user inside the
 * app. Purchases always happen on the merchant's own site (docs/MASTER_SPEC.md §1).
 */
export async function openExternalUrl(value: string): Promise<void> {
  if (!isExternalHttpUrl(value)) {
    return;
  }
  await WebBrowser.openBrowserAsync(value.trim());
}
