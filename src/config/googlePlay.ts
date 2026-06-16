import { GoogleAuth } from 'google-auth-library';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * Authenticated client for the Google Play Android Publisher API
 * (used to verify subscription purchases server-side).
 *
 * Built lazily and cached so a misconfigured server can still boot — we only fail
 * when /api/v1/billing/* is actually called.
 */
let cachedAuth: GoogleAuth | null = null;
let initAttempted = false;

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export function getGooglePlayAuth(): GoogleAuth | null {
  if (cachedAuth || initAttempted) return cachedAuth;
  initAttempted = true;

  if (!env.googlePlay.isConfigured) {
    logger.warn(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set — server-side subscription verification disabled.',
    );
    return null;
  }

  try {
    const credentials = JSON.parse(env.googlePlay.serviceAccountJson);
    cachedAuth = new GoogleAuth({ credentials, scopes: [SCOPE] });
    logger.info('Google Play Android Publisher client initialized.');
    return cachedAuth;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Google Play client — billing disabled.');
    return null;
  }
}

/** Returns a fresh OAuth2 access token for the Android Publisher API. */
export async function getGooglePlayAccessToken(): Promise<string | null> {
  const auth = getGooglePlayAuth();
  if (!auth) return null;
  try {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token ?? null;
  } catch (err) {
    logger.error({ err }, 'Failed to obtain Google Play access token');
    return null;
  }
}
