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
import { listRecentPlayers } from '../services/recentPlayerService';
import { listSquadCandidates } from '../services/sessionSquadService';
import { getBlockedUserIds } from '../services/blockService';
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

/**
 * OkHttp / Gson often send explicit `null` for omitted fields; Zod's `.optional()` only
 * allows `undefined`, not `null`, which would otherwise 400 the whole PATCH.
 * Also map `looking_for` → `lookingFor`, drop invalid `locale`, and drop empty `age`.
 */
function normalizeProfilePatchInput(val: unknown): unknown {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
  const o = { ...(val as Record<string, unknown>) };

  if (o.lookingFor === undefined && o.looking_for !== undefined) {
    o.lookingFor = o.looking_for;
  }
  delete o.looking_for;

  for (const k of ['name', 'age', 'locale', 'selectedGame', 'lookingFor']) {
    if (o[k] === null) delete o[k];
  }
  if (o.age === '') delete o.age;

  const loc = o.locale;
  if (typeof loc === 'string' && loc !== 'en' && loc !== 'pt') {
    delete o.locale;
  }

  if (o.lookingFor != null && typeof o.lookingFor !== 'string') {
    o.lookingFor = String(o.lookingFor);
  }
  if (typeof o.name === 'string' && o.name.trim() === '') {
    delete o.name;
  }

  return o;
}

const updateProfileFields = z.object({
  name: z.string().min(2).max(60).optional(),
  age: z.coerce.number().int().min(13).max(120).optional(),
  locale: z.enum(['en', 'pt']).optional(),
  selectedGame: z.string().optional(),
  lookingFor: z
    .union([z.string().max(200), z.literal(''), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === '' || v === null) return null;
      const t = v.trim();
      return t.length === 0 ? null : t;
    }),
});

const updateProfileSchema = z.preprocess(normalizeProfilePatchInput, updateProfileFields);

userRouter.patch(
  '/me',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof updateProfileFields>;
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

userRouter.get(
  '/me/recent-players',
  requireAuth,
  asyncHandler(async (req, res) => {
    const players = await listRecentPlayers(req.userId!);
    res.json({ players });
  }),
);

userRouter.get(
  '/me/squad-candidates',
  requireAuth,
  validate(z.object({ gameId: z.string().min(1) }), 'query'),
  asyncHandler(async (req, res) => {
    const { gameId } = req.query as { gameId: string };
    const candidates = await listSquadCandidates(req.userId!, gameId);
    res.json({ candidates });
  }),
);

userRouter.get(
  '/game-profile-users',
  requireAuth,
  validate(z.object({ gameId: z.string().min(1) }), 'query'),
  asyncHandler(async (req, res) => {
    const { gameId } = req.query as { gameId: string };
    const blocked = await getBlockedUserIds(req.userId!);
    const exclude = new Set([req.userId!, ...blocked]);
    const onlineThreshold = new Date(Date.now() - 5 * 60_000);

    const profiles = await prisma.userGameProfile.findMany({
      where: {
        gameId,
        userId: { notIn: [...exclude] },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            photoUrl: true,
            lastSeenAt: true,
          },
        },
      },
    });

    const users = profiles.map((p) => ({
        userId: p.user.id,
        name: p.user.name,
        nickname: p.nickname,
        photoUrl: p.user.photoUrl,
        isOnline: (p.user.lastSeenAt?.getTime() ?? 0) > onlineThreshold.getTime(),
      }));

    res.json({ users });
  }),
);

userRouter.get(
  '/:id/public',
  requireAuth,
  asyncHandler(async (req, res) => {
    const viewerId = req.userId!;
    const targetId = req.params.id;
    const blocked = await getBlockedUserIds(viewerId);
    if (blocked.has(targetId)) throw HttpError.notFound('User not found');

    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        email: true,
        name: true,
        age: true,
        photoUrl: true,
        lookingFor: true,
        lastSeenAt: true,
        gameProfiles: true,
      },
    });
    if (!user) throw HttpError.notFound('User not found');

    const onlineThreshold = Date.now() - 5 * 60_000;
    res.json({
      user: {
        ...user,
        isOnline: (user.lastSeenAt?.getTime() ?? 0) > onlineThreshold,
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
      },
    });
  }),
);
