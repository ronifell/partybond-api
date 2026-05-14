import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../config/database';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../utils/httpError';
import { toPublicUser, loadUserById } from '../services/authService';
import { track } from '../services/analyticsService';
import { env } from '../config/env';

export const userRouter = Router();

// Ensure upload dir exists
fs.mkdirSync(env.uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, env.uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${req.userId}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: env.maxUploadSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) {
      cb(new HttpError(400, 'Only PNG/JPG/WEBP images are allowed', 'invalid_file'));
      return;
    }
    cb(null, true);
  },
});

const updateProfileSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  age: z.coerce.number().int().min(13).max(120).optional(),
  locale: z.enum(['en', 'pt']).optional(),
  selectedGame: z.string().optional(),
  lookingFor: z
    .union([z.string().max(60), z.literal(''), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === '' || v === null) return null;
      const t = v.trim();
      return t.length === 0 ? null : t;
    }),
});

userRouter.patch(
  '/me',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof updateProfileSchema>;
    const data: Prisma.UserUpdateInput = {};
    if (b.name !== undefined) data.name = b.name;
    if (b.age !== undefined) data.age = b.age;
    if (b.locale !== undefined) data.locale = b.locale;
    if (b.selectedGame !== undefined) data.selectedGame = b.selectedGame;
    if (b.lookingFor !== undefined) data.lookingFor = b.lookingFor;

    if (Object.keys(data).length === 0) {
      const user = await loadUserById(req.userId!);
      res.json({ user: toPublicUser(user) });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: req.userId! },
      data,
      include: { gameProfiles: true },
    });
    res.json({ user: toPublicUser(updated) });
  }),
);

userRouter.post(
  '/me/photo',
  requireAuth,
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw HttpError.badRequest('photo field is required');
    const url = `${env.appUrl}/uploads/${req.file.filename}`;
    const updated = await prisma.user.update({
      where: { id: req.userId! },
      data: { photoUrl: url },
      include: { gameProfiles: true },
    });
    res.json({ user: toPublicUser(updated) });
  }),
);

const fcmSchema = z.object({ token: z.string().min(10).max(500).nullable() });
userRouter.put(
  '/me/fcm-token',
  requireAuth,
  validate(fcmSchema),
  asyncHandler(async (req, res) => {
    await prisma.user.update({
      where: { id: req.userId! },
      data: { fcmToken: req.body.token },
    });
    res.json({ ok: true });
  }),
);

const gameProfileSchema = z.object({
  gameId: z.string().min(1),
  nickname: z.string().min(1).max(40),
  playerId: z.string().min(1).max(80),
});

userRouter.put(
  '/me/game-profile',
  requireAuth,
  validate(gameProfileSchema),
  asyncHandler(async (req, res) => {
    const { gameId, nickname, playerId } = req.body;

    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (!game) throw HttpError.notFound('Game not found');

    await prisma.userGameProfile.upsert({
      where: { userId_gameId: { userId: req.userId!, gameId } },
      update: { nickname, playerId },
      create: { userId: req.userId!, gameId, nickname, playerId },
    });

    const updated = await prisma.user.update({
      where: { id: req.userId! },
      data: { selectedGame: gameId },
      include: { gameProfiles: true },
    });

    void track('onboarding_complete', req.userId!, { gameId });
    void track('game_selected', req.userId!, { gameId });
    res.json({ user: toPublicUser(updated) });
  }),
);

userRouter.get(
  '/me/state',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await loadUserById(req.userId!);
    res.json({
      state: user.state,
      currentSessionId: user.currentSessionId,
      currentMatchId: user.currentMatchId,
    });
  }),
);
