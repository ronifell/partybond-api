import admin from 'firebase-admin';
import { env } from './env';
import { logger } from '../utils/logger';

let initialized = false;

export function getFirebaseAdmin(): typeof admin | null {
  if (initialized) return admin.apps.length ? admin : null;

  initialized = true;
  if (!env.firebaseServiceAccountJson) {
    logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled.');
    return null;
  }

  try {
    const credentials = JSON.parse(env.firebaseServiceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(credentials),
    });
    logger.info('Firebase Admin initialized.');
    return admin;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Firebase Admin — push disabled.');
    return null;
  }
}
