import { Router } from 'express';
import { prisma } from '../config/database';
import { asyncHandler } from '../utils/asyncHandler';

export const gameRouter = Router();

gameRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const games = await prisma.game.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    res.json({ games });
  }),
);
