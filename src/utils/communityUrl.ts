import { HttpError } from './httpError';

export const COMMUNITY_PLATFORMS = ['discord', 'facebook'] as const;
export type CommunityPlatform = (typeof COMMUNITY_PLATFORMS)[number];

function hostnameOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

export function assertCommunityUrl(platform: CommunityPlatform, raw: string): string {
  const trimmed = raw.trim();
  const host = hostnameOf(trimmed);
  if (!host) {
    throw HttpError.badRequest('Enter a valid https link', 'invalid_community_url');
  }
  const discord =
    host === 'discord.gg' ||
    host === 'discord.com' ||
    host === 'discordapp.com' ||
    host.endsWith('.discord.com') ||
    host.endsWith('.discord.gg');
  const facebook =
    host === 'facebook.com' ||
    host === 'fb.com' ||
    host === 'fb.me' ||
    host === 'm.facebook.com' ||
    host.endsWith('.facebook.com');
  if (platform === 'discord' && !discord) {
    throw HttpError.badRequest('Use a Discord invite or server link', 'invalid_community_url');
  }
  if (platform === 'facebook' && !facebook) {
    throw HttpError.badRequest('Use a Facebook page or group link', 'invalid_community_url');
  }
  return trimmed;
}
