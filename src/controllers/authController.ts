import { z } from 'zod';
import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middlewares/validate';
import { requireAuth } from '../middlewares/auth';
import * as authService from '../services/authService';
import { track } from '../services/analyticsService';

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(6).max(128),
  name: z.string().min(2).max(60),
  age: z.coerce.number().int().min(13).max(120),
  locale: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body);
    void track('register', result.user.id);
    res.status(201).json(result);
  }),
);

authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    void track('login', result.user.id);
    res.json(result);
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = await authService.getMe(req.userId!);
    res.json({ user: me });
  }),
);
