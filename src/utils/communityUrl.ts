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

function isDiscordHost(host: string): boolean {
  return (
    host === 'discord.gg' ||
    host === 'discord.com' ||
    host === 'discordapp.com' ||
    host.endsWith('.discord.com') ||
    host.endsWith('.discord.gg')
  );
}

function isFacebookHost(host: string): boolean {
  return (
    host === 'facebook.com' ||
    host === 'fb.com' ||
    host === 'fb.me' ||
    host === 'm.facebook.com' ||
    host.endsWith('.facebook.com')
  );
}

export function communityPlatformFromUrl(raw: string): CommunityPlatform | null {
  const host = hostnameOf(raw.trim());
  if (!host) return null;
  if (isDiscordHost(host)) return 'discord';
  if (isFacebookHost(host)) return 'facebook';
  return null;
}

export function slugFromName(name: string): string {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);
}

export function assertCommunityUrl(platform: CommunityPlatform, raw: string): string {
  const trimmed = raw.trim();
  const detected = communityPlatformFromUrl(trimmed);
  if (!detected) {
    throw HttpError.badRequest('Enter a valid Discord or Facebook https link', 'invalid_community_url');
  }
  if (platform === 'discord' && detected !== 'discord') {
    throw HttpError.badRequest('Use a Discord invite or server link', 'invalid_community_url');
  }
  if (platform === 'facebook' && detected !== 'facebook') {
    throw HttpError.badRequest('Use a Facebook page or group link', 'invalid_community_url');
  }
  return trimmed;
}
