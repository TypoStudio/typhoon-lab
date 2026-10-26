import { describe, expect, it } from 'vitest';
import { firebaseConfigFromEnv } from '../src/net/firebase';

const env = {
  VITE_FIREBASE_PROJECT_ID: 'p',
  VITE_FIREBASE_APP_ID: 'a',
  VITE_FIREBASE_API_KEY: 'k',
  VITE_FIREBASE_AUTH_DOMAIN: 'd',
  VITE_FIREBASE_STORAGE_BUCKET: 's',
  VITE_FIREBASE_MESSAGING_SENDER_ID: 'm',
};

describe('firebaseConfigFromEnv', () => {
  it('returns the config when all values are set', () => {
    expect(firebaseConfigFromEnv(env)).toEqual({ projectId: 'p', appId: 'a', apiKey: 'k', authDomain: 'd', storageBucket: 's', messagingSenderId: 'm' });
  });
  it('returns null when a value is missing or empty', () => {
    expect(firebaseConfigFromEnv({ ...env, VITE_FIREBASE_API_KEY: undefined })).toBeNull();
    expect(firebaseConfigFromEnv({ ...env, VITE_FIREBASE_APP_ID: '' })).toBeNull();
  });
});
