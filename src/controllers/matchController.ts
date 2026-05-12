import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../utils/httpError';
import { endMatch } from '../services/matchmakingService';
import { track } from '../services/analyticsService';
import { emitToUser } from '../socket';

export const matchRouter = Router();

const INTERACTIONS = [
  'add_me',
  'already_added',
  'enter_lobby',
  'waiting',
  'did_not_work',
] as const;

const interactionSchema = z.object({
  type: z.enum(INTERACTIONS),
});

matchRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const m = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        session: { include: { game: true } },
        userA: { include: { gameProfiles: true } },
        userB: { include: { gameProfiles: true } },
      },
    });
    if (!m) throw HttpError.notFound('Match not found');
    if (m.userAId !== req.userId && m.userBId !== req.userId) {
      throw HttpError.forbidden('Not a participant');
    }

    const me = m.userAId === req.userId ? m.userA : m.userB;
    const other = m.userAId === req.userId ? m.userB : m.userA;
    const profile = (u: typeof m.userA) =>
      u.gameProfiles.find((p) => p.gameId === m.session.gameId) ?? null;

    res.json({
      match: {
        id: m.id,
        status: m.status,
        gameId: m.session.gameId,
        gameName: m.session.game.name,
        sessionId: m.sessionId,
        expiresAt: m.expiresAt,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        me: {
          id: me.id,
          name: me.name,
          photoUrl: me.photoUrl,
          nickname: profile(me)?.nickname ?? null,
          playerId: profile(me)?.playerId ?? null,
        },
        opponent: {
          id: other.id,
          name: other.name,
          photoUrl: other.photoUrl,
          nickname: profile(other)?.nickname ?? null,
          playerId: profile(other)?.playerId ?? null,
        },
      },
    });
  }),
);

matchRouter.post(
  '/:id/interactions',
  requireAuth,
  validate(interactionSchema),
  asyncHandler(async (req, res) => {
    const matchId = req.params.id;
    const userId = req.userId!;
    const m = await prisma.match.findUnique({ where: { id: matchId } });
    if (!m) throw HttpError.notFound('Match not found');
    if (m.userAId !== userId && m.userBId !== userId) {
      throw HttpError.forbidden('Not a participant');
    }
    if (m.status !== 'active') throw HttpError.badRequest('Match is not active', 'match_inactive');

    const created = await prisma.interaction.create({
      data: { matchId, userId, type: req.body.type },
    });

    const otherUserId = m.userAId === userId ? m.userBId : m.userAId;
    emitToUser(otherUserId, 'match:interaction', {
      matchId,
      fromUserId: userId,
      type: req.body.type,
      at: created.createdAt,
    });

    void track('interaction_sent', userId, { matchId, type: req.body.type });
    res.status(201).json({ ok: true });
  }),
);

matchRouter.post(
  '/:id/finish',
  requireAuth,
  asyncHandler(async (req, res) => {
    const matchId = req.params.id;
    const userId = req.userId!;
    const m = await prisma.match.findUnique({ where: { id: matchId } });
    if (!m) throw HttpError.notFound('Match not found');
    if (m.userAId !== userId && m.userBId !== userId) {
      throw HttpError.forbidden('Not a participant');
    }
    const result = await endMatch(matchId, 'finished');
    emitToUser(m.userAId, 'match:ended', { matchId, status: 'finished' });
    emitToUser(m.userBId, 'match:ended', { matchId, status: 'finished' });
    void track('match_end', userId, { matchId });
    res.json({ match: result });
  }),
);
