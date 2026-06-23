import { z } from 'zod';

export const GAME_PLATFORMS = ['playstation', 'xbox', 'pc', 'mobile'] as const;

export type GamePlatform = (typeof GAME_PLATFORMS)[number];

export const gamePlatformSchema = z.enum(GAME_PLATFORMS);

export function isGamePlatform(value: unknown): value is GamePlatform {
  return typeof value === 'string' && (GAME_PLATFORMS as readonly string[]).includes(value);
}
