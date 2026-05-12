import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { signJwt } from '../utils/jwt';
import { HttpError } from '../utils/httpError';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  age: number;
  photoUrl: string | null;
  selectedGame: string | null;
  state: 'idle' | 'in_queue' | 'in_match';
  currentSessionId: string | null;
  currentMatchId: string | null;
  locale: string;
  gameProfiles: Array<{ gameId: string; nickname: string; playerId: string }>;
}

const PASSWORD_HASH_ROUNDS = 10;

function toPublicUser(user: Awaited<ReturnType<typeof loadUserById>>): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    age: user.age,
    photoUrl: user.photoUrl,
    selectedGame: user.selectedGame,
    state: user.state,
    currentSessionId: user.currentSessionId,
    currentMatchId: user.currentMatchId,
    locale: user.locale,
    gameProfiles: user.gameProfiles.map((p) => ({
      gameId: p.gameId,
      nickname: p.nickname,
      playerId: p.playerId,
    })),
  };
}

export async function loadUserById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { gameProfiles: true },
  });
  if (!user) throw HttpError.notFound('User not found');
  return user;
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
  age: number;
  locale?: string;
}) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw HttpError.conflict('Email already in use', 'email_in_use');

  const passwordHash = await bcrypt.hash(input.password, PASSWORD_HASH_ROUNDS);

  const created = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      age: input.age,
      locale: input.locale ?? 'en',
    },
    include: { gameProfiles: true },
  });

  const token = signJwt({ sub: created.id, email: created.email });
  return { token, user: toPublicUser(created) };
}

export async function login(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { gameProfiles: true },
  });
  if (!user) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw HttpError.unauthorized('Invalid credentials', 'invalid_credentials');

  const token = signJwt({ sub: user.id, email: user.email });
  return { token, user: toPublicUser(user) };
}

export async function getMe(userId: string) {
  const user = await loadUserById(userId);
  return toPublicUser(user);
}

export { toPublicUser };
