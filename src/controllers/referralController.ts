import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { env } from '../config/env';
import {
  buildPlayStoreUrl,
  getInviteLink,
  getReferralStats,
  listMyReferrals,
  lookupReferralCode,
  normalizeCode,
  redeemReferralOnSignup,
} from '../services/referralService';

export const referralRouter = Router();

/** Owner's invite code, share URL, and Play Store URL with referrer baked in. */
referralRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const link = await getInviteLink(req.userId!);
    const stats = await getReferralStats(req.userId!);
    res.json({ ...link, stats });
  }),
);

referralRouter.get(
  '/history',
  requireAuth,
  asyncHandler(async (req, res) => {
    const referrals = await listMyReferrals(req.userId!);
    res.json({ referrals });
  }),
);

/**
 * Optional — call from the app after a fresh signup if the user pasted a code
 * that wasn't sent in the register payload. Idempotent.
 */
referralRouter.post(
  '/redeem',
  requireAuth,
  validate(z.object({ code: z.string().min(2).max(16) })),
  asyncHandler(async (req, res) => {
    await redeemReferralOnSignup(req.userId!, (req.body as { code: string }).code);
    res.json({ ok: true });
  }),
);

/** Public — used by the landing page to show "you were invited by X". */
referralRouter.get(
  '/lookup/:code',
  asyncHandler(async (req, res) => {
    const data = await lookupReferralCode(req.params.code);
    if (!data) {
      res.status(404).json({ error: { code: 'unknown_code', message: 'Unknown invite code' } });
      return;
    }
    res.json(data);
  }),
);

// ---------------------------------------------------------------------------
// Public invite landing page  —  GET /i/:code  (no /api/v1 prefix).
// Detects the visitor's platform (Android / iOS / desktop) and either redirects
// straight to the Play Store / App Store, or renders a small HTML landing page.
// ---------------------------------------------------------------------------

export const inviteRedirectRouter = Router();

inviteRedirectRouter.get(
  '/:code',
  asyncHandler(async (req, res) => {
    const code = normalizeCode(req.params.code);
    const ua = (req.headers['user-agent'] ?? '').toLowerCase();
    const isAndroid = ua.includes('android');
    const isIos = /iphone|ipad|ipod/.test(ua);

    if (isAndroid) {
      res.redirect(302, buildPlayStoreUrl(code));
      return;
    }
    if (isIos) {
      res.redirect(302, env.referral.appStoreUrl);
      return;
    }

    // Desktop / unknown: render a friendly landing page with both store links.
    const lookup = code ? await lookupReferralCode(code) : null;
    const inviterName = lookup?.inviter.name ?? '';
    const html = renderInviteLandingHtml({
      code: code || '',
      inviterName,
      playStoreUrl: buildPlayStoreUrl(code),
      appStoreUrl: env.referral.appStoreUrl,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.send(html);
  }),
);

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderInviteLandingHtml(args: {
  code: string;
  inviterName: string;
  playStoreUrl: string;
  appStoreUrl: string;
}): string {
  const safeName = escapeHtml(args.inviterName);
  const safeCode = escapeHtml(args.code);
  const heading = safeName
    ? `${safeName} invited you to Partybond`
    : 'You were invited to Partybond';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Partybond invite${safeName ? ` from ${safeName}` : ''}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at 20% 0%, #2a0d4a 0%, #0a0a12 55%) #0a0a12;
    color: #fff; display: flex; align-items: center; justify-content: center;
  }
  .card {
    max-width: 420px; width: 100%; padding: 28px;
    border-radius: 24px; border: 1px solid rgba(255,255,255,0.08);
    background: rgba(20,20,32,0.7); backdrop-filter: blur(12px);
    text-align: center;
  }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 800; letter-spacing: -0.2px; }
  p  { margin: 0 0 20px; color: #B8B8CC; line-height: 1.5; font-size: 14px; }
  .code {
    display: inline-block; padding: 10px 18px; border-radius: 12px;
    background: rgba(123,63,242,0.15); border: 1px solid rgba(123,63,242,0.4);
    color: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 18px; font-weight: 700; letter-spacing: 2px; margin-bottom: 22px;
  }
  .btn {
    display: block; width: 100%; padding: 14px 16px; margin-top: 10px;
    border-radius: 14px; text-decoration: none; font-weight: 700; font-size: 15px;
    color: #fff;
  }
  .btn-primary {
    background: linear-gradient(135deg, #FF4DA6, #7B3FF2 55%, #00D1FF);
  }
  .btn-secondary {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
  }
  small { display: block; margin-top: 18px; color: #6B6B80; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>Install Partybond and use your invite code on first launch to claim your reward.</p>
    ${safeCode ? `<div class="code">${safeCode}</div>` : ''}
    <a class="btn btn-primary" href="${escapeHtml(args.playStoreUrl)}">Get it on Google Play</a>
    <a class="btn btn-secondary" href="${escapeHtml(args.appStoreUrl)}">Download on the App Store</a>
    <small>Already have the app? Open it and tap "I have an invite code".</small>
  </div>
</body>
</html>`;
}
