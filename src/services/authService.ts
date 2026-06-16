import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { signJwt } from '../utils/jwt';
import { HttpError } from '../utils/httpError';
import { sendPasswordResetCode } from './emailService';
import { verifyGoogleIdToken } from './googleAuthService';
import { redeemReferralOnSignup } from './referralService';

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
  isAdmin: boolean;
  /** ISO date string when premium runs out (null = never had premium / fully expired). */
  premiumUntil: string | null;
  /** True iff `premiumUntil` is in the future. Convenience for the client. */
  isPremium: boolean;
  gameProfiles: Array<{ gameId: string; nickname: string; playerId: string }>;
}

const PASSWORD_HASH_ROUNDS = 10;

function toPublicUser(user: Awaited<ReturnType<typeof loadUserById>>): PublicUser {
  const now = Date.now();
  const premiumUntil = user.premiumUntil ?? null;
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
    isAdmin: user.isAdmin ?? false,
    premiumUntil: premiumUntil ? premiumUntil.toISOString() : null,
    isPremium: !!premiumUntil && premiumUntil.getTime() > now,
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
  inviteCode?: string;
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

  // Best-effort referral redemption — non-fatal on errors.
  if (input.inviteCode) {
    await redeemReferralOnSignup(created.id, input.inviteCode);
  }

  const token = signJwt({ sub: created.id, email: created.email });
  return { token, user: toPublicUser(created) };
}

async function randomPasswordHash(): Promise<string> {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), PASSWORD_HASH_ROUNDS);
}

/** Sign in or register via Google ID token (from mobile OAuth). */
export async function loginWithGoogle(idToken: string, locale?: string) {
  const profile = await verifyGoogleIdToken(idToken);

  let user = await prisma.user.findFirst({
    where: {
      OR: [{ googleId: profile.googleId }, { email: profile.email }],
    },
    include: { gameProfiles: true },
  });

  if (user) {
    if (user.googleId && user.googleId !== profile.googleId) {
      throw HttpError.conflict('Email linked to another Google account', 'google_account_mismatch');
    }
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: profile.googleId,
          photoUrl: user.photoUrl ?? profile.photoUrl,
          name: user.name || profile.name,
        },
        include: { gameProfiles: true },
      });
    }
  } else {
    user = await prisma.user.create({
      data: {
        email: profile.email,
        googleId: profile.googleId,
        passwordHash: await randomPasswordHash(),
        name: profile.name,
        age: 18,
        photoUrl: profile.photoUrl,
        locale: locale ?? 'en',
      },
      include: { gameProfiles: true },
    });
  }

  const token = signJwt({ sub: user.id, email: user.email });
  return { token, user: toPublicUser(user) };
}

export async function login(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { gameProfiles: true },
  });
  if (!user) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  if (user.bannedAt) {
    throw HttpError.forbidden(
      user.banReason ? `Account suspended: ${user.banReason}` : 'Account suspended',
      'account_banned',
    );
  }

  const token = signJwt({ sub: user.id, email: user.email });
  return { token, user: toPublicUser(user) };
}

/**
 * Admin-only login. Same credentials check + must have isAdmin=true.
 * Used by the web admin panel; mobile app users use the normal login endpoint.
 */
export async function adminLogin(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { gameProfiles: true },
  });
  if (!user) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  if (user.bannedAt) throw HttpError.forbidden('Account suspended', 'account_banned');
  if (!user.isAdmin) throw HttpError.forbidden('Admin privileges required', 'not_admin');

  const token = signJwt({ sub: user.id, email: user.email });
  return { token, user: toPublicUser(user), isAdmin: true };
}

export async function getMe(userId: string) {
  const user = await loadUserById(userId);
  return toPublicUser(user);
}

const RESET_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function hashResetCode(raw: string): string {
  return crypto.createHash('sha256').update(raw.trim()).digest('hex');
}

function generateResetCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
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

  const code = generateResetCode();
  const tokenHash = hashResetCode(code);
  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS);

  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  try {
    await sendPasswordResetCode(user.email, code);
  } catch {
    // Do not leak email delivery failures to the client.
  }

  return { ok: true as const };
}

export async function resetPassword(identifier: string, code: string, password: string) {
  const user = await findUserByIdentifier(identifier);
  if (!user) {
    throw HttpError.badRequest('Invalid or expired code', 'invalid_reset_code');
  }

  const tokenHash = hashResetCode(code);
  const record = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

  if (!record) {
    throw HttpError.badRequest('Invalid or expired code', 'invalid_reset_code');
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
