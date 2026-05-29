/**
 * Admin API — backs the Next.js admin panel.
 *
 * All routes are mounted under `/api/v1/admin` and guarded by `requireAuth` + `requireAdmin`.
 * Mobile app endpoints are untouched.
 */
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { requireAuth } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../utils/httpError';
import { track } from '../services/analyticsService';
import {
  extFromMime,
  gameImagePublicUrl,
  getGameImagesDir,
  removeExistingGameImages,
} from '../services/gameImageService';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

    const [
      users,
      newUsers24h,
      newUsers7d,
      bannedUsers,
      admins,
      games,
      activeGames,
      sessions,
      openSessions,
      activeMatches,
      finishedMatches,
      openReports,
      totalReports,
      recentRegistrations,
      recentMatchesEvents,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      prisma.user.count({ where: { isAdmin: true } }),
      prisma.game.count(),
      prisma.game.count({ where: { status: 'active' } }),
      prisma.session.count(),
      prisma.session.count({ where: { status: 'open' } }),
      prisma.match.count({ where: { status: 'active' } }),
      prisma.match.count({ where: { status: 'finished' } }),
      prisma.userReport.count({ where: { status: 'open' } }),
      prisma.userReport.count(),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, name: true, email: true, photoUrl: true, createdAt: true },
      }),
      prisma.analyticsEvent.findMany({
        where: { name: { in: ['match_start', 'match_end'] }, createdAt: { gte: weekAgo } },
        select: { name: true, createdAt: true },
      }),
    ]);

    // Per-day match counts for the last 7 days (rough chart data)
    const buckets: Record<string, { day: string; matches: number; ended: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60_000);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { day: key, matches: 0, ended: 0 };
    }
    for (const ev of recentMatchesEvents) {
      const key = ev.createdAt.toISOString().slice(0, 10);
      if (buckets[key]) {
        if (ev.name === 'match_start') buckets[key].matches++;
        if (ev.name === 'match_end') buckets[key].ended++;
      }
    }

    res.json({
      counts: {
        users,
        newUsers24h,
        newUsers7d,
        bannedUsers,
        admins,
        games,
        activeGames,
        sessions,
        openSessions,
        activeMatches,
        finishedMatches,
        openReports,
        totalReports,
      },
      recentRegistrations,
      matchesChart: Object.values(buckets),
    });
  }),
);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const listUsersQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'banned', 'admin']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get(
  '/users',
  validate(listUsersQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof listUsersQuery>;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const where: Prisma.UserWhereInput = {};
    if (q.search) {
      where.OR = [
        { email: { contains: q.search, mode: 'insensitive' } },
        { name: { contains: q.search, mode: 'insensitive' } },
        { id: { equals: q.search } },
      ];
    }
    if (q.status === 'banned') where.bannedAt = { not: null };
    if (q.status === 'active') where.bannedAt = null;
    if (q.status === 'admin') where.isAdmin = true;

    const [total, items] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          age: true,
          photoUrl: true,
          selectedGame: true,
          state: true,
          locale: true,
          isAdmin: true,
          bannedAt: true,
          banReason: true,
          lastSeenAt: true,
          createdAt: true,
          _count: { select: { reportsReceived: true, reportsFiled: true } },
        },
      }),
    ]);

    res.json({ items, total, page, pageSize });
  }),
);

adminRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        gameProfiles: { include: { game: { select: { id: true, name: true } } } },
        _count: {
          select: {
            reportsReceived: true,
            reportsFiled: true,
            matchesAsA: true,
            matchesAsB: true,
            createdSessions: true,
          },
        },
      },
    });
    if (!user) throw HttpError.notFound('User not found');

    const recentReportsReceived = await prisma.userReport.findMany({
      where: { reportedId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        reporter: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ user, recentReportsReceived });
  }),
);

const banSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

adminRouter.post(
  '/users/:id/ban',
  validate(banSchema),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.userId) {
      throw HttpError.badRequest('You cannot ban yourself');
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw HttpError.notFound('User not found');
    if (target.isAdmin) throw HttpError.badRequest('Cannot ban another admin');

    const body = req.body as z.infer<typeof banSchema>;
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        bannedAt: new Date(),
        banReason: body.reason ?? null,
        state: 'idle',
        currentSessionId: null,
        currentMatchId: null,
        fcmToken: null,
      },
      select: { id: true, bannedAt: true, banReason: true },
    });

    void track('admin_user_banned', req.userId!, { targetId: req.params.id });
    res.json({ user: updated });
  }),
);

adminRouter.post(
  '/users/:id/unban',
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw HttpError.notFound('User not found');

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { bannedAt: null, banReason: null },
      select: { id: true, bannedAt: true, banReason: true },
    });

    void track('admin_user_unbanned', req.userId!, { targetId: req.params.id });
    res.json({ user: updated });
  }),
);

const adminFlagSchema = z.object({
  isAdmin: z.boolean(),
});

adminRouter.patch(
  '/users/:id/admin',
  validate(adminFlagSchema),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.userId) {
      throw HttpError.badRequest('You cannot change your own admin flag');
    }
    const body = req.body as z.infer<typeof adminFlagSchema>;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw HttpError.notFound('User not found');

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isAdmin: body.isAdmin },
      select: { id: true, isAdmin: true },
    });

    void track('admin_flag_changed', req.userId!, {
      targetId: req.params.id,
      isAdmin: body.isAdmin,
    });
    res.json({ user: updated });
  }),
);

adminRouter.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    if (req.params.id === req.userId) {
      throw HttpError.badRequest('You cannot delete yourself');
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw HttpError.notFound('User not found');
    if (target.isAdmin) throw HttpError.badRequest('Cannot delete another admin');

    await prisma.user.delete({ where: { id: req.params.id } });
    void track('admin_user_deleted', req.userId!, { targetId: req.params.id });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const listReportsQuery = z.object({
  status: z.enum(['all', 'open', 'reviewed', 'dismissed']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get(
  '/reports',
  validate(listReportsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof listReportsQuery>;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const where: Prisma.UserReportWhereInput = {};
    if (q.status && q.status !== 'all') where.status = q.status;

    const [total, items] = await Promise.all([
      prisma.userReport.count({ where }),
      prisma.userReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          reporter: { select: { id: true, name: true, email: true, photoUrl: true } },
          reported: {
            select: {
              id: true,
              name: true,
              email: true,
              photoUrl: true,
              bannedAt: true,
            },
          },
        },
      }),
    ]);

    res.json({ items, total, page, pageSize });
  }),
);

const updateReportSchema = z.object({
  status: z.enum(['open', 'reviewed', 'dismissed']),
  adminNote: z.string().max(2000).optional(),
});

adminRouter.patch(
  '/reports/:id',
  validate(updateReportSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateReportSchema>;
    const existing = await prisma.userReport.findUnique({ where: { id: req.params.id } });
    if (!existing) throw HttpError.notFound('Report not found');

    const updated = await prisma.userReport.update({
      where: { id: req.params.id },
      data: {
        status: body.status,
        adminNote: body.adminNote ?? null,
        resolvedAt: body.status === 'open' ? null : new Date(),
        resolvedById: body.status === 'open' ? null : req.userId!,
      },
    });

    void track('admin_report_updated', req.userId!, {
      reportId: req.params.id,
      status: body.status,
    });
    res.json({ report: updated });
  }),
);

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

adminRouter.get(
  '/games',
  asyncHandler(async (_req, res) => {
    const games = await prisma.game.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { sessions: true, gameProfiles: true } },
      },
    });
    res.json({ games });
  }),
);

const gameIdRegex = /^[a-z][a-z0-9_]{1,40}$/;

const createGameSchema = z.object({
  id: z.string().regex(gameIdRegex, 'lowercase letters, digits, underscore, 2-41 chars'),
  name: z.string().min(2).max(80),
  status: z.enum(['active', 'coming_soon']).default('coming_soon'),
  maxPlayers: z.coerce.number().int().min(2).max(50).default(4),
});

adminRouter.post(
  '/games',
  validate(createGameSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createGameSchema>;
    const exists = await prisma.game.findUnique({ where: { id: body.id } });
    if (exists) throw HttpError.conflict('Game ID already exists');

    const game = await prisma.game.create({
      data: {
        id: body.id,
        name: body.name,
        status: body.status,
        maxPlayers: body.maxPlayers,
      },
    });
    void track('admin_game_created', req.userId!, { gameId: game.id });
    res.status(201).json({ game });
  }),
);

const updateGameSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  status: z.enum(['active', 'coming_soon']).optional(),
  maxPlayers: z.coerce.number().int().min(2).max(50).optional(),
});

adminRouter.patch(
  '/games/:id',
  validate(updateGameSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateGameSchema>;
    const exists = await prisma.game.findUnique({ where: { id: req.params.id } });
    if (!exists) throw HttpError.notFound('Game not found');

    const data: Prisma.GameUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.status !== undefined) data.status = body.status;
    if (body.maxPlayers !== undefined) data.maxPlayers = body.maxPlayers;

    const game = await prisma.game.update({ where: { id: req.params.id }, data });
    void track('admin_game_updated', req.userId!, { gameId: game.id });
    res.json({ game });
  }),
);

adminRouter.delete(
  '/games/:id',
  asyncHandler(async (req, res) => {
    const exists = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { sessions: true, gameProfiles: true } } },
    });
    if (!exists) throw HttpError.notFound('Game not found');

    if (exists._count.sessions > 0 || exists._count.gameProfiles > 0) {
      throw HttpError.badRequest(
        'Game still has sessions or player profiles. Set status to "coming_soon" instead, or remove dependencies first.',
        'game_in_use',
      );
    }

    await prisma.game.delete({ where: { id: req.params.id } });
    void track('admin_game_deleted', req.userId!, { gameId: req.params.id });
    res.json({ ok: true });
  }),
);

const gameImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, getGameImagesDir()),
    filename: (req, file, cb) => {
      const ext = extFromMime(file.mimetype);
      cb(null, `${req.params.id}.${ext}`);
    },
  }),
  limits: { fileSize: env.maxUploadSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) {
      cb(new HttpError(415, 'Only PNG, JPEG, WebP, and GIF images are allowed', 'invalid_file'));
      return;
    }
    cb(null, true);
  },
});

adminRouter.post(
  '/games/:id/image',
  asyncHandler(async (req, res, next) => {
    const exists = await prisma.game.findUnique({ where: { id: req.params.id } });
    if (!exists) throw HttpError.notFound('Game not found');
    await removeExistingGameImages(req.params.id);
    next();
  }),
  (req, res, next) => {
    gameImageUpload.single('image')(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        next(
          HttpError.badRequest(
            `File too large. Max ${env.maxUploadSizeMb} MB.`,
            'file_too_large',
          ),
        );
        return;
      }
      next(err);
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) throw HttpError.badRequest('image field is required', 'missing_image');
    res.json({ ok: true, url: gameImagePublicUrl(req.params.id) });
  }),
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const listSessionsQuery = z.object({
  status: z.enum(['all', 'open', 'active', 'finished']).optional(),
  gameId: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get(
  '/sessions',
  validate(listSessionsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof listSessionsQuery>;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const where: Prisma.SessionWhereInput = {};
    if (q.status && q.status !== 'all') where.status = q.status;
    if (q.gameId) where.gameId = q.gameId;

    const [total, items] = await Promise.all([
      prisma.session.count({ where }),
      prisma.session.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          game: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          _count: { select: { queue: true, matches: true } },
        },
      }),
    ]);

    res.json({ items, total, page, pageSize });
  }),
);

adminRouter.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const exists = await prisma.session.findUnique({ where: { id: req.params.id } });
    if (!exists) throw HttpError.notFound('Session not found');

    await prisma.session.delete({ where: { id: req.params.id } });
    void track('admin_session_deleted', req.userId!, { sessionId: req.params.id });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Matches & interactions
// ---------------------------------------------------------------------------

const listMatchesQuery = z.object({
  status: z.enum(['all', 'active', 'finished', 'expired']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get(
  '/matches',
  validate(listMatchesQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof listMatchesQuery>;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;

    const where: Prisma.MatchWhereInput = {};
    if (q.status && q.status !== 'all') where.status = q.status;

    const [total, items] = await Promise.all([
      prisma.match.count({ where }),
      prisma.match.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          session: { select: { id: true, title: true, gameId: true } },
          userA: { select: { id: true, name: true, email: true, photoUrl: true } },
          userB: { select: { id: true, name: true, email: true, photoUrl: true } },
          _count: { select: { interactions: true } },
        },
      }),
    ]);

    res.json({ items, total, page, pageSize });
  }),
);

adminRouter.get(
  '/matches/:id/interactions',
  asyncHandler(async (req, res) => {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        userA: { select: { id: true, name: true, photoUrl: true } },
        userB: { select: { id: true, name: true, photoUrl: true } },
        interactions: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, photoUrl: true } } },
        },
      },
    });
    if (!match) throw HttpError.notFound('Match not found');
    res.json({ match });
  }),
);

adminRouter.post(
  '/matches/:id/finish',
  asyncHandler(async (req, res) => {
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) throw HttpError.notFound('Match not found');
    if (match.status !== 'active') throw HttpError.badRequest('Match is not active');

    const updated = await prisma.$transaction(async (tx) => {
      const m = await tx.match.update({
        where: { id: match.id },
        data: { status: 'finished', endedAt: new Date() },
      });
      await tx.user.updateMany({
        where: { id: { in: [match.userAId, match.userBId] } },
        data: { state: 'idle', currentSessionId: null, currentMatchId: null },
      });
      return m;
    });

    void track('admin_match_finished', req.userId!, { matchId: match.id });
    res.json({ match: updated });
  }),
);

// ---------------------------------------------------------------------------
// Account — self-service profile & password update for the logged-in admin
// ---------------------------------------------------------------------------

const updateAccountSchema = z
  .object({
    name: z.string().min(2).max(60).optional(),
    email: z.string().email().toLowerCase().optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(6).max(128).optional(),
  })
  .refine((d) => !d.newPassword || !!d.currentPassword, {
    message: 'currentPassword is required when setting a new password',
    path: ['currentPassword'],
  });

adminRouter.patch(
  '/account',
  validate(updateAccountSchema),
  asyncHandler(async (req, res) => {
    const { name, email, currentPassword, newPassword } =
      req.body as z.infer<typeof updateAccountSchema>;

    const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });

    if (email && email !== admin.email) {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) {
        res.status(409).json({ error: { message: 'Email already in use', code: 'email_taken' } });
        return;
      }
    }

    if (newPassword) {
      const valid = await bcrypt.compare(currentPassword!, admin.passwordHash);
      if (!valid) {
        res
          .status(400)
          .json({ error: { message: 'Current password is incorrect', code: 'wrong_password' } });
        return;
      }
    }

    const updated = await prisma.user.update({
      where: { id: req.userId! },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(newPassword ? { passwordHash: await bcrypt.hash(newPassword, 10) } : {}),
      },
      select: { id: true, name: true, email: true, photoUrl: true, isAdmin: true },
    });

    res.json({ user: updated });
  }),
);
