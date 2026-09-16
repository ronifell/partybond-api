import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { RESCUE_MATCH_TYPES, RESCUE_MIC_PREFERENCES, RESCUE_PLATFORMS } from '../constants/squadRescue';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import * as rescue from '../services/squadRescueService';

export const squadRescueRouter = Router();

const guestLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many guest sessions. Try again later.', code: 'rate_limited' } },
});

const createLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many squads created. Try again later.', code: 'rate_limited' } },
});

const joinLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many join attempts. Try again later.', code: 'rate_limited' } },
});

const visitLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests.', code: 'rate_limited' } },
});

const guestSchema = z.object({
  guestKey: z.string().min(16).max(80),
  locale: z.enum(['en', 'pt']).optional(),
});

const createSchema = z.object({
  game: z.string().trim().min(1).max(60),
  platform: z.enum(RESCUE_PLATFORMS),
  matchType: z.enum(RESCUE_MATCH_TYPES),
  gameMode: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((value) => (value ? value : undefined)),
  extrasNeeded: z.coerce.number().int().min(1).max(7),
  nickname: z.string().trim().min(2).max(24),
  gameUid: z.string().trim().min(2).max(40),
  micPreference: z.enum(RESCUE_MIC_PREFERENCES),
  communityId: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
});

const joinSchema = z.object({
  nickname: z.string().trim().min(2).max(24),
  gameUid: z.string().trim().min(2).max(40),
  hasMic: z.boolean(),
  confirmGameId: z.literal(true),
});

const codeParam = z.object({
  code: z.string().regex(/^[A-Za-z0-9]{6,12}$/),
});

const slugParam = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,39}$/),
});

squadRescueRouter.post(
  '/guest',
  guestLimiter,
  validate(guestSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof guestSchema>;
    const result = await rescue.ensureGuest(body);
    res.json(result);
  }),
);

squadRescueRouter.post(
  '/',
  createLimiter,
  requireAuth,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const squad = await rescue.createRescue(req.userId!, body);
    res.status(201).json({ squad });
  }),
);

squadRescueRouter.get(
  '/communities/:slug',
  validate(slugParam, 'params'),
  asyncHandler(async (req, res) => {
    const community = await rescue.getCommunity(req.params.slug);
    res.json({ community });
  }),
);

squadRescueRouter.post(
  '/communities/:slug/visit',
  visitLimiter,
  validate(slugParam, 'params'),
  asyncHandler(async (req, res) => {
    const community = await rescue.recordCommunityVisit(req.params.slug);
    res.json({ community });
  }),
);

squadRescueRouter.get(
  '/:code',
  validate(codeParam, 'params'),
  asyncHandler(async (req, res) => {
    const squad = await rescue.getPublicRescue(req.params.code);
    res.json({ squad });
  }),
);

squadRescueRouter.get(
  '/:code/me',
  requireAuth,
  validate(codeParam, 'params'),
  asyncHandler(async (req, res) => {
    const squad = await rescue.getMemberRescue(req.params.code, req.userId!);
    res.json({ squad });
  }),
);

squadRescueRouter.post(
  '/:code/join',
  joinLimiter,
  requireAuth,
  validate(codeParam, 'params'),
  validate(joinSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof joinSchema>;
    const squad = await rescue.joinRescue(req.params.code, req.userId!, body);
    res.json({ squad });
  }),
);

squadRescueRouter.post(
  '/:code/leave',
  requireAuth,
  validate(codeParam, 'params'),
  asyncHandler(async (req, res) => {
    const squad = await rescue.leaveRescue(req.params.code, req.userId!);
    res.json({ squad });
  }),
);

squadRescueRouter.post(
  '/:code/end',
  requireAuth,
  validate(codeParam, 'params'),
  asyncHandler(async (req, res) => {
    const squad = await rescue.endRescue(req.params.code, req.userId!);
    res.json({ squad });
  }),
);

squadRescueRouter.post(
  '/:code/play-again',
  createLimiter,
  requireAuth,
  validate(codeParam, 'params'),
  asyncHandler(async (req, res) => {
    const squad = await rescue.playAgain(req.params.code, req.userId!);
    res.status(201).json({ squad });
  }),
);
