import { Server as IoServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { verifyJwt } from '../utils/jwt';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../config/database';
import { emitTyping } from '../services/chatService';

let io: IoServer | null = null;

/**
 * In-memory presence tracker: userId → number of active socket connections.
 * A user is considered "truly online" only while this count is > 0.
 * We rely on this (in addition to lastSeenAt) to avoid matchmaking with
 * users who simply left their app open a few minutes ago.
 */
const socketsByUser = new Map<string, Set<string>>();

/** True if the given user currently has at least one live socket connection. */
export function isUserSocketConnected(userId: string): boolean {
  const set = socketsByUser.get(userId);
  return !!set && set.size > 0;
}

/** Snapshot of user IDs currently connected — filter a candidate list to only real online users. */
export function filterOnlineUserIds(userIds: readonly string[]): string[] {
  return userIds.filter((id) => isUserSocketConnected(id));
}

/** When the user's last socket disconnects we clear queue state so we don't match with a ghost. */
async function handleUserFullyDisconnected(userId: string): Promise<void> {
  try {
    // Remove any pending progressive-matchmaking entry.
    await prisma.globalQueueEntry.deleteMany({ where: { userId } });
    // Also remove any session-scoped queue entries; without this the row
    // survives the disconnect and matchmaking keeps trying (and skipping) it.
    await prisma.queueEntry.deleteMany({ where: { userId } });
    // If the user was mid-queue, reset their state so matchmaking won't pick them up.
    await prisma.user.updateMany({
      where: { id: userId, state: 'in_queue' },
      data: { state: 'idle', currentSessionId: null },
    });
    // Zero-out lastSeenAt so downstream `isOnline` checks (which look at recency) return false.
    await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: null } });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to clean up presence on disconnect');
  }
}

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

    // Track this socket for presence.
    let set = socketsByUser.get(userId);
    if (!set) {
      set = new Set<string>();
      socketsByUser.set(userId, set);
    }
    set.add(socket.id);

    void prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
    logger.debug({ userId, sid: socket.id, socketsForUser: set.size }, 'socket connected');

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
      const remaining = socketsByUser.get(userId);
      if (remaining) {
        remaining.delete(socket.id);
        if (remaining.size === 0) {
          socketsByUser.delete(userId);
          void handleUserFullyDisconnected(userId);
        }
      }
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
