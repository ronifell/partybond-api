import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../config/database';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { HttpError } from '../utils/httpError';
import { track } from '../services/analyticsService';
import { env } from '../config/env';

export const moderationRouter = Router();

const REPORT_CATEGORIES = [
  'spam',
  'harassment',
  'offensive_language',
  'inappropriate_content',
  'other',
] as const;

const MAX_REPORT_ATTACHMENTS = 4;

const reportSchema = z.object({
  reportedId: z.string().min(1),
  category: z.enum(REPORT_CATEGORIES),
  details: z.string().max(2000).optional(),
});

fs.mkdirSync(env.uploadDir, { recursive: true });

const reportUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, env.uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `report-${req.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: env.maxUploadSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) {
      cb(new HttpError(400, 'Only PNG/JPG/WEBP images are allowed', 'invalid_file') as unknown as Error);
      return;
    }
    cb(null, true);
  },
});

function isMultipart(req: { headers: { 'content-type'?: string } }) {
  return (req.headers['content-type'] ?? '').includes('multipart/form-data');
}

function attachmentUrlsFromFiles(files: Express.Multer.File[] | undefined): string[] {
  if (!files?.length) return [];
  if (files.length > MAX_REPORT_ATTACHMENTS) {
    throw HttpError.badRequest(
      `At most ${MAX_REPORT_ATTACHMENTS} images allowed`,
      'too_many_attachments',
    );
  }
  return files.map((f) => `${env.appUrl}/uploads/${f.filename}`);
}

async function createUserReport(
  reporterId: string,
  data: z.infer<typeof reportSchema>,
  attachmentUrls: string[],
) {
  if (data.reportedId === reporterId) throw HttpError.badRequest('Cannot report yourself');
  await prisma.userReport.create({
    data: {
      reporterId,
      reportedId: data.reportedId,
      category: data.category,
      details: data.details,
      attachmentUrls,
    },
  });
  void track('user_reported', reporterId, {
    reportedId: data.reportedId,
    category: data.category,
    attachmentCount: attachmentUrls.length,
  });
}

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
  (req, res, next) => {
    if (!isMultipart(req)) return next();
    reportUpload.array('attachments', MAX_REPORT_ATTACHMENTS)(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        next(HttpError.badRequest('Image too large', 'file_too_large'));
        return;
      }
      next(err);
    });
  },
  asyncHandler(async (req, res) => {
    const rawBody = isMultipart(req)
      ? {
          reportedId: req.body.reportedId,
          category: req.body.category,
          details: req.body.details === '' ? undefined : req.body.details,
        }
      : req.body;

    const parsed = reportSchema.safeParse(rawBody);
    if (!parsed.success) throw HttpError.badRequest('Invalid report payload', 'validation_error');

    const files = isMultipart(req) ? (req.files as Express.Multer.File[] | undefined) : undefined;
    const attachmentUrls = attachmentUrlsFromFiles(files);
    await createUserReport(req.userId!, parsed.data, attachmentUrls);
    res.status(201).json({ ok: true });
  }),
);
