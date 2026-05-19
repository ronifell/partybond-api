import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { signJwt } from '../utils/jwt';
import { HttpError } from '../utils/httpError';
import { sendPasswordResetEmail } from './emailService';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  age: number;
  photoUrl: string | null;
  lookingFor: string | null;
  selectedGame: string | null;
  state: 'idle' | 'in_queue' | 'in_match';
  currentSessionId: string | null;
  currentMatchId: string | null;
  locale: string;
  gameProfiles: Array<{ gameId: string; nickname: string; playerId: string }>;
}

const PASSWORD_HASH_ROUNDS = 10;

function toPublicUser(user: Awaited<ReturnType<typeof loadUserById>>): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    age: user.age,
    photoUrl: user.photoUrl,
    lookingFor: user.lookingFor ?? null,
    selectedGame: user.selectedGame,
    state: user.state,
    currentSessionId: user.currentSessionId,
    currentMatchId: user.currentMatchId,
    locale: user.locale,
    gameProfiles: user.gameProfiles.map((p) => ({
      gameId: p.gameId,
      nickname: p.nickname,
      playerId: p.playerId,
    })),
  };
}

export async function loadUserById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { gameProfiles: true },
  });
  if (!user) throw HttpError.notFound('User not found');
  return user;
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
  age: number;
  locale?: string;
}) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw HttpError.conflict('Email already in use', 'email_in_use');

  const passwordHash = await bcrypt.hash(input.password, PASSWORD_HASH_ROUNDS);

  const created = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      age: input.age,
      locale: input.locale ?? 'en',
    },
    include: { gameProfiles: true },
  });

  const token = signJwt({ sub: created.id, email: created.email });
  return { token, user: toPublicUser(created) };
}

export async function login(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { gameProfiles: true },
  });
  if (!user) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  const token = signJwt({ sub: user.id, email: user.email });
  return { token, user: toPublicUser(user) };
}

export async function getMe(userId: string) {
  const user = await loadUserById(userId);
  return toPublicUser(user);
}

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function findUserByIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  if (trimmed.includes('@')) {
    return prisma.user.findUnique({ where: { email: trimmed.toLowerCase() } });
  }

  const byName = await prisma.user.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
  });
  if (byName) return byName;

  const profile = await prisma.userGameProfile.findFirst({
    where: { nickname: { equals: trimmed, mode: 'insensitive' } },
    include: { user: true },
  });
  return profile?.user ?? null;
}

/** Always resolves without revealing whether the account exists. */
export async function requestPasswordReset(identifier: string) {
  const user = await findUserByIdentifier(identifier);
  if (!user) return { ok: true as const };

  const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  const resetUrl = `${env.resetLinkBase}?token=${encodeURIComponent(rawToken)}`;
  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch {
    // Do not leak email delivery failures to the client.
  }

  return { ok: true as const };
}

export async function resetPassword(token: string, password: string) {
  const tokenHash = hashResetToken(token.trim());
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw HttpError.badRequest('Invalid or expired reset link', 'invalid_reset_token');
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);

  return { ok: true as const };
}

export { toPublicUser };
