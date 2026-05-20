import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';

const client = new OAuth2Client();

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  photoUrl: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  const audiences = env.google.clientIds;
  if (audiences.length === 0) {
    throw HttpError.badRequest('Google Sign-In is not configured on the server', 'google_not_configured');
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: audiences,
    });
    payload = ticket.getPayload();
  } catch {
    throw HttpError.unauthorized('Invalid Google sign-in token', 'invalid_google_token');
  }

  if (!payload?.sub || !payload.email) {
    throw HttpError.unauthorized('Invalid Google sign-in token', 'invalid_google_token');
  }

  if (payload.email_verified === false) {
    throw HttpError.badRequest('Google email is not verified', 'google_email_unverified');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: (payload.name ?? payload.email.split('@')[0]).slice(0, 60),
    photoUrl: payload.picture ?? null,
  };
}
