import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../utils/httpError';
import { track } from '../services/analyticsService';

export const moderationRouter = Router();

const reportSchema = z.object({
  reportedId: z.string().min(1),
  category: z.enum([
    'spam',
    'harassment',
    'offensive_language',
    'inappropriate_content',
    'other',
  ]),
  details: z.string().max(2000).optional(),
});

moderationRouter.post(
  '/block',
  requireAuth,
  validate(z.object({ userId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const blockedId = (req.body as { userId: string }).userId;
    if (blockedId === req.userId) throw HttpError.badRequest('Cannot block yourself');
    await prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: req.userId!, blockedId } },
      create: { blockerId: req.userId!, blockedId },
      update: {},
    });
    void track('user_blocked', req.userId!, { blockedId });
    res.json({ ok: true });
  }),
);

moderationRouter.delete(
  '/block/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.userBlock.deleteMany({
      where: { blockerId: req.userId!, blockedId: req.params.userId },
    });
    res.json({ ok: true });
  }),
);

moderationRouter.post(
  '/report',
  requireAuth,
  validate(reportSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reportSchema>;
    if (body.reportedId === req.userId) throw HttpError.badRequest('Cannot report yourself');
    await prisma.userReport.create({
      data: {
        reporterId: req.userId!,
        reportedId: body.reportedId,
        category: body.category,
        details: body.details,
      },
    });
    void track('user_reported', req.userId!, { reportedId: body.reportedId, category: body.category });
    res.status(201).json({ ok: true });
  }),
);
