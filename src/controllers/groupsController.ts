import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import * as groupService from '../services/groupService';
import * as scheduleService from '../services/scheduleService';
import * as squadFillService from '../services/squadFillService';

export const groupsRouter = Router();

const createGroupSchema = z.object({
  name: z.string().min(2).max(60),
  memberIds: z.array(z.string()).optional(),
});

groupsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const groups = await groupService.listGroups(req.userId!);
    res.json({ groups });
  }),
);

groupsRouter.post(
  '/',
  requireAuth,
  validate(createGroupSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createGroupSchema>;
    const group = await groupService.createGroup(req.userId!, body.name, body.memberIds);
    res.status(201).json({ group });
  }),
);

groupsRouter.get(
  '/invites/pending',
  requireAuth,
  asyncHandler(async (req, res) => {
    const invites = await groupService.listPendingInvites(req.userId!);
    res.json({ invites });
  }),
);

groupsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await groupService.getGroupDetail(req.params.id, req.userId!);
    res.json({ group });
  }),
);

groupsRouter.post(
  '/:id/invites',
  requireAuth,
  validate(z.object({ inviteeId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const result = await groupService.inviteToGroup(
      req.params.id,
      req.userId!,
      (req.body as { inviteeId: string }).inviteeId,
    );
    res.status(201).json(result);
  }),
);

groupsRouter.post(
  '/invites/:inviteId/respond',
  requireAuth,
  validate(z.object({ accept: z.boolean() })),
  asyncHandler(async (req, res) => {
    const result = await groupService.respondGroupInvite(
      req.params.inviteId,
      req.userId!,
      (req.body as { accept: boolean }).accept,
    );
    res.json(result);
  }),
);

groupsRouter.delete(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await groupService.removeMember(req.params.id, req.userId!, req.params.userId);
    res.json({ ok: true });
  }),
);

groupsRouter.post(
  '/:id/leave',
  requireAuth,
  asyncHandler(async (req, res) => {
    await groupService.leaveGroup(req.params.id, req.userId!);
    res.json({ ok: true });
  }),
);

const scheduleSchema = z.object({
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  timeLocal: z.string().regex(/^\d{2}:\d{2}$/),
  frequency: z.enum(['weekly', 'biweekly']).optional(),
  timezone: z.string().optional(),
});

groupsRouter.post(
  '/:id/schedules',
  requireAuth,
  validate(scheduleSchema),
  asyncHandler(async (req, res) => {
    const result = await scheduleService.createGroupSchedule(
      req.params.id,
      req.userId!,
      req.body as z.infer<typeof scheduleSchema>,
    );
    res.status(201).json({
      schedule: result.schedule,
      nextSession: {
        id: result.nextSession.id,
        startsAt: result.nextSession.startsAt.toISOString(),
      },
    });
  }),
);

groupsRouter.post(
  '/sessions/:sessionId/rsvp',
  requireAuth,
  validate(z.object({ status: z.enum(['confirmed', 'declined']) })),
  asyncHandler(async (req, res) => {
    await scheduleService.setRsvp(
      req.params.sessionId,
      req.userId!,
      (req.body as { status: 'confirmed' | 'declined' }).status,
    );
    res.json({ ok: true });
  }),
);

groupsRouter.get(
  '/:id/squad-fill/suggestions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await squadFillService.getSquadFillSuggestions(req.params.id, req.userId!);
    res.json(data);
  }),
);

groupsRouter.post(
  '/:id/squad-fill/invites',
  requireAuth,
  validate(z.object({ inviteeId: z.string(), sessionId: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const body = req.body as { inviteeId: string; sessionId?: string };
    const result = await squadFillService.inviteSquadFill(
      req.params.id,
      req.userId!,
      body.inviteeId,
      body.sessionId,
    );
    res.status(201).json(result);
  }),
);

groupsRouter.post(
  '/squad-fill/:inviteId/respond',
  requireAuth,
  validate(z.object({ accept: z.boolean() })),
  asyncHandler(async (req, res) => {
    const result = await squadFillService.respondSquadFillInvite(
      req.params.inviteId,
      req.userId!,
      (req.body as { accept: boolean }).accept,
    );
    res.json(result);
  }),
);
