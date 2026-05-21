import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../utils/httpError';
import { track } from '../services/analyticsService';
import { tryDrainSession } from '../services/matchmakingService';
import * as sessionSquadService from '../services/sessionSquadService';
import { emitToSession } from '../socket';
import { TX_OPTIONS } from '../config/prismaTx';

export const sessionRouter = Router();

const skillTierEnum = z.enum(['beginner', 'intermediate', 'advanced', 'veteran']);

const createSessionSchema = z.object({
  gameId: z.string().min(1),
  title: z.string().min(2).max(60),
  gameMode: z.enum(['casual', 'competitive']),
  skillTier: skillTierEnum.optional().default('beginner'),
  playersNeeded: z.coerce.number().int().min(2).max(8).optional(),
  scheduledAt: z.coerce.date().optional(),
});

const listQuerySchema = z.object({
  gameId: z.string().optional(),
  gameMode: z.enum(['casual', 'competitive']).optional(),
  skillTier: skillTierEnum.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

sessionRouter.get(
  '/',
  requireAuth,
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { gameId, gameMode, skillTier, limit } = req.query as unknown as {
      gameId?: string;
      gameMode?: 'casual' | 'competitive';
      skillTier?: 'beginner' | 'intermediate' | 'advanced' | 'veteran';
      limit: number;
    };
    const sessions = await prisma.session.findMany({
      where: {
        status: { in: ['open', 'active'] },
        ...(gameId ? { gameId } : {}),
        ...(gameMode ? { gameMode } : {}),
        ...(skillTier ? { skillTier } : {}),
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
      include: {
        game: true,
        createdBy: { select: { id: true, name: true, photoUrl: true } },
        _count: { select: { queue: true } },
      },
    });
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        gameId: s.gameId,
        gameName: s.game.name,
        gameMode: s.gameMode,
        skillTier: s.skillTier,
        playersNeeded: s.playersNeeded,
        scheduledAt: s.scheduledAt,
        status: s.status,
        createdBy: s.createdBy,
        waitingCount: s._count.queue,
      })),
    });
  }),
);

sessionRouter.post(
  '/',
  requireAuth,
  validate(createSessionSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSessionSchema>;

    const game = await prisma.game.findUnique({ where: { id: body.gameId } });
    if (!game) throw HttpError.notFound('Game not found');
    if (game.status !== 'active') throw HttpError.badRequest('Game not active', 'game_inactive');

    const scheduledAt = body.scheduledAt ?? new Date();
    const status = scheduledAt.getTime() <= Date.now() ? 'active' : 'open';
    const playersNeeded = body.playersNeeded ?? Math.min(game.maxPlayers, 4);

    const session = await prisma.session.create({
      data: {
        gameId: body.gameId,
        title: body.title,
        gameMode: body.gameMode,
        skillTier: body.skillTier,
        playersNeeded,
        scheduledAt,
        status,
        createdById: req.userId!,
      },
    });
    void track('session_created', req.userId!, { sessionId: session.id });
    res.status(201).json({ session });
  }),
);

sessionRouter.get(
  '/squad-invites/pending',
  requireAuth,
  asyncHandler(async (req, res) => {
    const invites = await sessionSquadService.listPendingSessionSquadInvites(req.userId!);
    res.json({ invites });
  }),
);

sessionRouter.post(
  '/squad-invites/:inviteId/respond',
  requireAuth,
  validate(z.object({ accept: z.boolean() })),
  asyncHandler(async (req, res) => {
    const result = await sessionSquadService.respondSessionSquadInvite(
      req.params.inviteId,
      req.userId!,
      (req.body as { accept: boolean }).accept,
    );
    res.json(result);
  }),
);

sessionRouter.post(
  '/:id/squad-invites',
  requireAuth,
  validate(z.object({ inviteeIds: z.array(z.string().min(1)).min(1).max(8) })),
  asyncHandler(async (req, res) => {
    const result = await sessionSquadService.sendSessionSquadInvites(
      req.params.id,
      req.userId!,
      (req.body as { inviteeIds: string[] }).inviteeIds,
    );
    res.json(result);
  }),
);

sessionRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const s = await prisma.session.findUnique({
      where: { id: req.params.id },
      include: {
        game: true,
        createdBy: { select: { id: true, name: true, photoUrl: true } },
        queue: {
          include: { user: { select: { id: true, name: true, photoUrl: true } } },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!s) throw HttpError.notFound('Session not found');
    res.json({
      session: {
        id: s.id,
        title: s.title,
        gameId: s.gameId,
        gameName: s.game.name,
        gameMode: s.gameMode,
        skillTier: s.skillTier,
        playersNeeded: s.playersNeeded,
        scheduledAt: s.scheduledAt,
        status: s.status,
        createdBy: s.createdBy,
        waiting: s.queue.map((q) => q.user),
      },
    });
  }),
);

// JOIN QUEUE
sessionRouter.post(
  '/:id/queue',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.userId!;

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw HttpError.notFound('User not found');
      if (user.state !== 'idle') {
        throw HttpError.conflict(
          `User is currently ${user.state}, cannot join queue`,
          'invalid_state',
        );
      }

      const session = await tx.session.findUnique({ where: { id: sessionId } });
      if (!session) throw HttpError.notFound('Session not found');
      if (session.status === 'finished') {
        throw HttpError.badRequest('Session finished', 'session_finished');
      }

      // Make sure user has a profile for the session's game.
      const profile = await tx.userGameProfile.findUnique({
        where: { userId_gameId: { userId, gameId: session.gameId } },
      });
      if (!profile) {
        throw HttpError.badRequest('Set your game profile first', 'no_game_profile');
      }

      await tx.queueEntry.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        create: { sessionId, userId },
        update: {},
      });

      await tx.user.update({
        where: { id: userId },
        data: { state: 'in_queue', currentSessionId: sessionId, currentMatchId: null },
      });
    }, TX_OPTIONS);

    void track('queue_join', userId, { sessionId });

    const waitingCount = await prisma.queueEntry.count({ where: { sessionId } });
    emitToSession(sessionId, 'queue:update', { sessionId, waitingCount });

    // Try to pair immediately (best-effort, async)
    void tryDrainSession(sessionId);

    res.json({ ok: true, waitingCount });
  }),
);

// LEAVE QUEUE
sessionRouter.delete(
  '/:id/queue',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.userId!;
    await prisma.$transaction(async (tx) => {
      await tx.queueEntry.deleteMany({ where: { sessionId, userId } });
      await tx.user.update({
        where: { id: userId },
        data: { state: 'idle', currentSessionId: null, currentMatchId: null },
      });
    }, TX_OPTIONS);
    void track('queue_leave', userId, { sessionId });
    const waitingCount = await prisma.queueEntry.count({ where: { sessionId } });
    emitToSession(sessionId, 'queue:update', { sessionId, waitingCount });
    res.json({ ok: true, waitingCount });
  }),
);
