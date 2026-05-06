import { getCryptoClient } from './crypto-client';

export interface BuildShareLinkUrlOptions {
  readonly baseUrl: string;
  readonly albumId: string;
  readonly linkId: string;
  readonly linkUrlToken: string;
}

export async function buildShareLinkUrl(
  options: BuildShareLinkUrlOptions,
): Promise<string> {
  const crypto = await getCryptoClient();
  const url = await crypto.buildShareLinkUrl(options);
  if (!url) {
    throw new Error('Failed to build share link URL');
  }
  return url;
}
