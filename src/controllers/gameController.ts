import { Router } from 'express';
import { prisma } from '../config/database';
import { asyncHandler } from '../utils/asyncHandler';

export const gameRouter = Router();

gameRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const games = await prisma.game.findMany({
      where: { id: { not: 'custom' } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    res.json({ games });
  }),
);
