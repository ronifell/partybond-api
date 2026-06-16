import crypto from 'node:crypto';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { grantManualPremium } from './billingService';
import { track } from './analyticsService';

/**
 * Code format: 8 characters, uppercased, base32-ish alphabet without ambiguous chars
 * (no 0/O, 1/I/L). Short enough to type / paste from a chat.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;

function generateRawCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const idx = crypto.randomInt(0, CODE_ALPHABET.length);
    out += CODE_ALPHABET[idx];
  }
  return out;
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

/**
 * Returns the user's referral code, creating it on first call. Idempotent.
 * Codes are immutable — once created we keep them forever to preserve links
 * already shared in the wild.
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { userId } });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = generateRawCode();
    try {
      const row = await prisma.referralCode.create({ data: { userId, code } });
      return row.code;
    } catch (err) {
      // P2002 == unique constraint hit (very rare collision). Retry with a new code.
      if ((err as { code?: string }).code === 'P2002') continue;
      throw err;
    }
  }
  throw HttpError.badRequest('Could not generate a referral code', 'referral_code_collision');
}

export interface InviteLink {
  code: string;
  url: string;
  playStoreUrl: string;
}

export async function getInviteLink(userId: string): Promise<InviteLink> {
  const code = await getOrCreateReferralCode(userId);
  return {
    code,
    url: `${env.referral.baseUrl}/${code}`,
    playStoreUrl: buildPlayStoreUrl(code),
  };
}

/**
 * Builds the Play Store URL with an install-referrer payload. The friend installs the app
 * and the install referrer (containing the inviter's code) becomes available to the app
 * for attribution.
 */
export function buildPlayStoreUrl(code: string): string {
  const referrer = encodeURIComponent(`invite_${code}`);
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(
    env.googlePlay.packageName,
  )}&referrer=${referrer}`;
}

/**
 * Called when a brand-new user signs up. If they entered an invite code, link them
 * to the inviter and credit the inviter `REFERRAL_REWARD_DAYS` of premium.
 *
 * Safe to call with `null`/empty codes — no-op in that case.
 */
export async function redeemReferralOnSignup(
  inviteeId: string,
  rawCode: string | null | undefined,
): Promise<void> {
  if (!rawCode) return;
  const code = normalizeCode(rawCode);
  if (!code) return;

  const referralCode = await prisma.referralCode.findUnique({
    where: { code },
    select: { userId: true, code: true },
  });
  if (!referralCode || referralCode.userId === inviteeId) {
    // Unknown or self-referral — silently ignore so we never block signup.
    return;
  }

  const existing = await prisma.referral.findUnique({ where: { inviteeId } });
  if (existing) return;

  try {
    const referral = await prisma.referral.create({
      data: {
        inviterId: referralCode.userId,
        inviteeId,
        code: referralCode.code,
        status: 'registered',
        rewardDays: env.referral.rewardDays,
      },
    });

    await prisma.user.update({
      where: { id: inviteeId },
      data: { referredByCode: referralCode.code },
    });

    if (env.referral.rewardDays > 0) {
      await grantManualPremium(
        referralCode.userId,
        env.referral.rewardDays,
        `referral:${referral.id}`,
      );
      await prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'rewarded', rewardGrantedAt: new Date() },
      });
    }

    void track('referral_redeemed', inviteeId, {
      inviterId: referralCode.userId,
      code: referralCode.code,
      rewardDays: env.referral.rewardDays,
    });
  } catch (err) {
    // We never want a hiccup in the referral pipeline to break account creation.
    logger.warn({ err, inviteeId, code }, 'redeemReferralOnSignup failed (non-fatal)');
  }
}

export async function listMyReferrals(userId: string) {
  const referrals = await prisma.referral.findMany({
    where: { inviterId: userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      invitee: { select: { id: true, name: true, photoUrl: true, createdAt: true } },
    },
  });
  return referrals.map((r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    rewardDays: r.rewardDays,
    rewardGrantedAt: r.rewardGrantedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    invitee: r.invitee
      ? {
          id: r.invitee.id,
          name: r.invitee.name,
          photoUrl: r.invitee.photoUrl,
          joinedAt: r.invitee.createdAt.toISOString(),
        }
      : null,
  }));
}

export async function getReferralStats(userId: string) {
  const [totalInvites, rewarded] = await Promise.all([
    prisma.referral.count({ where: { inviterId: userId } }),
    prisma.referral.count({ where: { inviterId: userId, status: 'rewarded' } }),
  ]);
  return {
    totalInvites,
    rewardedInvites: rewarded,
    daysEarned: rewarded * env.referral.rewardDays,
    rewardDaysPerInvite: env.referral.rewardDays,
  };
}

/**
 * Server-side resolution of a code from the invite landing page click (e.g. someone tapped
 * "Get the app" on the desktop landing). Returns inviter display info — used to render
 * "You were invited by Alex" so the invitee feels welcomed before installing.
 */
export async function lookupReferralCode(rawCode: string) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const row = await prisma.referralCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, name: true, photoUrl: true } } },
  });
  if (!row) return null;
  return {
    code: row.code,
    inviter: { id: row.user.id, name: row.user.name, photoUrl: row.user.photoUrl },
  };
}
