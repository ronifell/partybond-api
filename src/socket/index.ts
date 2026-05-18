import { Server as IoServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { verifyJwt } from '../utils/jwt';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../config/database';
import { emitTyping } from '../services/chatService';
import { tryMatchGlobalQueue } from '../services/progressiveMatchmakingService';

let io: IoServer | null = null;

export function initSocket(httpServer: HttpServer): IoServer {
  io = new IoServer(httpServer, {
    cors: {
      origin: env.clientOrigins.includes('*') ? true : env.clientOrigins,
      credentials: true,
    },
  });

  io.use((socket: Socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/, '');
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = verifyJwt(token);
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    void prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
    logger.debug({ userId, sid: socket.id }, 'socket connected');

    socket.on('presence:heartbeat', () => {
      void prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
    });

    socket.on('chat:typing', (payload: { conversationId?: string; isTyping?: boolean }) => {
      if (typeof payload?.conversationId === 'string') {
        emitTyping(payload.conversationId, userId, !!payload.isTyping);
      }
    });

    socket.on('session:subscribe', (sessionId: string) => {
      if (typeof sessionId === 'string') socket.join(`session:${sessionId}`);
    });
    socket.on('session:unsubscribe', (sessionId: string) => {
      if (typeof sessionId === 'string') socket.leave(`session:${sessionId}`);
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, sid: socket.id }, 'socket disconnected');
    });
  });

  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToSession(sessionId: string, event: string, payload: unknown): void {
  io?.to(`session:${sessionId}`).emit(event, payload);
}

export function getIo(): IoServer | null {
  return io;
}
