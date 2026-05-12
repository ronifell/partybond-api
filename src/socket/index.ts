import { Server as IoServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { verifyJwt } from '../utils/jwt';
import { env } from '../config/env';
import { logger } from '../utils/logger';

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
    logger.debug({ userId, sid: socket.id }, 'socket connected');

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
