import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';

export const GAME_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

export const GAME_IMAGE_MIME_BY_EXT: Record<(typeof GAME_IMAGE_EXTENSIONS)[number], string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Same rule as admin game IDs — used for image URLs and upload paths. */
export const GAME_ID_REGEX = /^[a-z][a-z0-9_]{1,40}$/;

export function getGameImagesDir(): string {
  return env.gameImagesDir;
}

fs.mkdirSync(getGameImagesDir(), { recursive: true });

export function extFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

export async function findGameImageFile(
  gameId: string,
): Promise<{ filePath: string; ext: string } | null> {
  const dir = getGameImagesDir();
  for (const ext of GAME_IMAGE_EXTENSIONS) {
    const filePath = path.join(dir, `${gameId}.${ext}`);
    try {
      await fsPromises.access(filePath, fs.constants.R_OK);
      return { filePath, ext };
    } catch {
      // try next extension
    }
  }
  return null;
}

export async function removeExistingGameImages(gameId: string): Promise<void> {
  const dir = getGameImagesDir();
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return;
  }

  const prefix = `${gameId}.`;
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map((name) => fsPromises.unlink(path.join(dir, name)).catch(() => undefined)),
  );
}

export function gameImagePublicUrl(gameId: string): string {
  return `${env.appUrl.replace(/\/$/, '')}/game-images/${gameId}`;
}
