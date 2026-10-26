/** Lazy Firebase bootstrap: the SDK is imported only when the leaderboard is first used, so the main bundle does not grow. */
import type { Firestore } from 'firebase/firestore';

export interface FirebaseConfig {
  projectId: string; appId: string; apiKey: string; authDomain: string; storageBucket: string; messagingSenderId: string;
}

/** Builds the public web config (identifies the project; access is controlled by firestore.rules) from `VITE_FIREBASE_*` values; null when any is missing. */
export function firebaseConfigFromEnv(env: Record<string, string | undefined>): FirebaseConfig | null {
  const config = {
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  };
  return Object.values(config).every(Boolean) ? config as FirebaseConfig : null;
}

export interface FirebaseSession { db: Firestore; uid: string }
let session: Promise<FirebaseSession> | null = null;

/** Initialises the app, signs in anonymously and resolves with Firestore and the anonymous uid. A failure is not cached, so a later call retries. */
export function getFirebase(): Promise<FirebaseSession> {
  if (!session) {
    const config = firebaseConfigFromEnv(import.meta.env);
    if (!config) return Promise.reject(new Error('Leaderboard is not configured: set VITE_FIREBASE_* in .env.local'));
    const attempt = (async () => {
      const [{ initializeApp }, { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInAnonymously }, { getFirestore }] =
        await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
      const app = initializeApp(config);
      const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
      await auth.authStateReady();
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
      return { db: getFirestore(app), uid: user.uid };
    })();
    session = attempt;
    attempt.catch(() => { if (session === attempt) session = null; });
  }
  return session;
}
