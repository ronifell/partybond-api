import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import * as chatService from '../services/chatService';

export const chatRouter = Router();

chatRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const conversations = await chatService.listConversations(req.userId!);
    res.json({ conversations });
  }),
);

chatRouter.post(
  '/direct',
  requireAuth,
  validate(z.object({ userId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const conv = await chatService.getOrCreateDirectConversation(
      req.userId!,
      (req.body as { userId: string }).userId,
    );
    res.json({ conversation: conv });
  }),
);

chatRouter.get(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const data = await chatService.listMessages(req.params.id, req.userId!, cursor);
    res.json(data);
  }),
);

chatRouter.post(
  '/:id/messages',
  requireAuth,
  validate(
    z.object({
      body: z.string().min(1).max(4000),
      replyToId: z.string().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { body: string; replyToId?: string };
    const message = await chatService.sendMessage(
      req.params.id,
      req.userId!,
      body.body,
      body.replyToId,
    );
    res.status(201).json({ message });
  }),
);

chatRouter.post(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    await chatService.markConversationRead(req.params.id, req.userId!);
    res.json({ ok: true });
  }),
);

chatRouter.post(
  '/:id/pin',
  requireAuth,
  validate(z.object({ messageId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    await chatService.pinMessage(
      req.params.id,
      req.userId!,
      (req.body as { messageId: string }).messageId,
    );
    res.json({ ok: true });
  }),
);
