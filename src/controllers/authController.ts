import { z } from 'zod';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { requireAuth } from '../middlewares/auth';
import * as authService from '../services/authService';
import { track } from '../services/analyticsService';

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(6).max(128),
  name: z.string().min(2).max(60),
  age: z.coerce.number().int().min(14).max(120),
  locale: z.string().optional(),
  /** Optional invite code redeemed at signup — credits the inviter with premium days. */
  inviteCode: z.string().min(2).max(16).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

const googleAuthSchema = z.object({
  idToken: z.string().min(10),
  locale: z.string().optional(),
});

const forgotPasswordSchema = z.object({
  identifier: z.string().min(2).max(120),
});

const resetPasswordSchema = z.object({
  identifier: z.string().min(2).max(120),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  password: z.string().min(6).max(128),
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Try again later.', code: 'rate_limited' } },
});

export const authRouter = Router();

authRouter.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof registerSchema>;
    const result = await authService.register(body);
    void track('register', result.user.id, body.inviteCode ? { inviteCode: body.inviteCode } : undefined);
    res.status(201).json(result);
  }),
);

authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    void track('login', result.user.id);
    res.json(result);
  }),
);

authRouter.post(
  '/admin/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.adminLogin(req.body);
    void track('admin_login', result.user.id);
    res.json(result);
  }),
);

authRouter.post(
  '/google',
  validate(googleAuthSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.loginWithGoogle(req.body.idToken, req.body.locale);
    void track('login_google', result.user.id);
    res.json(result);
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = await authService.getMe(req.userId!);
    res.json({ user: me });
  }),
);

authRouter.post(
  '/forgot-password',
  passwordResetLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.requestPasswordReset(req.body.identifier);
    res.json({
      ok: true,
      message: 'If an account exists, a verification code has been sent.',
    });
  }),
);

authRouter.post(
  '/reset-password',
  passwordResetLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body.identifier, req.body.code, req.body.password);
    res.json({ ok: true, message: 'Password updated. You can log in now.' });
  }),
);
