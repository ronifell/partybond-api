export const CUSTOM_GAME_ID = 'custom';

/** Client-confirmed duration for an open Squad Rescue. */
export const SQUAD_RESCUE_TTL_MS = 15 * 60 * 1000;

export const RESCUE_CODE_LENGTH = 8;

/** Alphabet without I/O/0/1 to keep codes easy to read aloud. */
export const RESCUE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const GAME_ALIASES: Record<string, string> = {
  ff: 'free_fire',
  ff3: 'free_fire',
  freefire: 'free_fire',
  'free fire': 'free_fire',
  valorant: 'valorant',
  val: 'valorant',
  cod: 'cod_mobile',
  codm: 'cod_mobile',
  'cod mobile': 'cod_mobile',
  'call of duty': 'cod_mobile',
  'call of duty mobile': 'cod_mobile',
  lol: 'league_of_legends',
  'league of legends': 'league_of_legends',
  cs2: 'counter_strike_2',
  cs: 'counter_strike_2',
  'counter strike': 'counter_strike_2',
  'counter-strike 2': 'counter_strike_2',
  fortnite: 'fortnite',
  fn: 'fortnite',
  minecraft: 'minecraft',
  roblox: 'roblox',
  pubg: 'pubg_mobile',
  'pubg mobile': 'pubg_mobile',
  ml: 'mobile_legends',
  mlbb: 'mobile_legends',
  'mobile legends': 'mobile_legends',
  fc26: 'ea_sports_fc_26',
  'ea fc': 'ea_sports_fc_26',
  'elden ring': 'elden_ring_nightreign',
};

export const RESCUE_MATCH_TYPES = ['ranked', 'casual', 'custom', 'tournament', 'any'] as const;
export type RescueMatchType = (typeof RESCUE_MATCH_TYPES)[number];

export const RESCUE_PLATFORMS = [
  'mobile',
  'pc',
  'playstation',
  'xbox',
  'switch',
  'cross_platform',
  'other',
] as const;
export type RescuePlatform = (typeof RESCUE_PLATFORMS)[number];

export const RESCUE_MIC_PREFERENCES = ['yes', 'no', 'any'] as const;
export type RescueMicPreference = (typeof RESCUE_MIC_PREFERENCES)[number];

export function isRescueMatchType(value: unknown): value is RescueMatchType {
  return typeof value === 'string' && (RESCUE_MATCH_TYPES as readonly string[]).includes(value);
}

export function isRescuePlatform(value: unknown): value is RescuePlatform {
  return typeof value === 'string' && (RESCUE_PLATFORMS as readonly string[]).includes(value);
}

export function isRescueMicPreference(value: unknown): value is RescueMicPreference {
  return typeof value === 'string' && (RESCUE_MIC_PREFERENCES as readonly string[]).includes(value);
}

export function sessionModeFromMatchType(matchType: RescueMatchType): 'casual' | 'competitive' {
  return matchType === 'ranked' ? 'competitive' : 'casual';
}
