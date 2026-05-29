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

/** Sibling admin panel folder names (production vs local repo layout). */
const ADMIN_SIBLING_FOLDERS = ['partybond-admin', 'Admin'] as const;

function resolveGameImagesDir(): string {
  const explicit = process.env.GAME_IMAGES_DIR?.trim();
  if (explicit) return path.resolve(explicit);

  const cwd = process.cwd();

  // Prefer the admin panel's public/games when it sits next to the API process.
  for (const folder of ADMIN_SIBLING_FOLDERS) {
    const candidate = path.resolve(cwd, '..', folder, 'public', 'games');
    try {
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return candidate;
    } catch {
      // try next layout
    }
  }

  // Self-contained fallback — no dependency on admin folder name.
  return path.resolve(cwd, 'game-images');
}

const gameImagesDir = resolveGameImagesDir();
fs.mkdirSync(gameImagesDir, { recursive: true });

export function getGameImagesDir(): string {
  return gameImagesDir;
}

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
