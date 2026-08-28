import * as WebBrowser from 'expo-web-browser';

/**
 * Only absolute http(s) URLs may be opened. External URLs are validated
 * before use so a malformed or non-web scheme from the catalogue can never
 * reach the browser (docs/MASTER_SPEC.md §14).
 */
const HTTP_URL = /^https?:\/\/\S+$/i;

export function isExternalHttpUrl(value: string): boolean {
  return HTTP_URL.test(value.trim());
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
