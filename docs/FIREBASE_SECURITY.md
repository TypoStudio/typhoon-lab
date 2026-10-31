# Firebase web key security

`src/net/firebase.ts` reads the web configuration from `VITE_FIREBASE_*`. Keep
values in the ignored `.env.local` file or the deployment environment. `.env.example`
must contain empty placeholders only. Vite includes these values in the browser
bundle, so moving a key into an environment variable does not make it secret.

[Firebase documents web API keys as project identifiers](https://firebase.google.com/docs/projects/api-keys).
Firestore Security Rules and Firebase Authentication control access to data.
API restrictions limit which Google services can use a key; HTTP referrer
restrictions limit supported browser origins. Referrers are not a substitute
for authentication or Security Rules.

## Current key restrictions

The replacement key resource is `typhoon-web-20261026` in project
`typhoon-typostudio`. Do not put the key string in this document or Git.

Allowed HTTP referrers:

- `https://typhoon.typostudio.dev/*`
- `https://typhoon-typostudio.web.app/*`
- `https://typhoon-typostudio.firebaseapp.com/*`
- `http://localhost:5186/*` and `http://127.0.0.1:5186/*` (development)
- `http://localhost:4173/*` and `http://127.0.0.1:4173/*` (production preview)

Allowed APIs:

- `firebase.googleapis.com`
- `logging.googleapis.com`
- `datastore.googleapis.com`
- `firestore.googleapis.com`
- `identitytoolkit.googleapis.com`
- `securetoken.googleapis.com`

Update restrictions before changing domains, development ports, or Firebase
products. Other Google APIs should use separate keys.

## Rotation procedure

1. Create a replacement key with the required API and referrer restrictions in
   [Google Cloud credentials](https://console.cloud.google.com/apis/credentials?project=typhoon-typostudio).
2. Replace `VITE_FIREBASE_API_KEY` in `.env.local` and any deployment environments.
   Rebuild the app: changing an environment file does not update an existing bundle.
3. Run the Firebase configuration and leaderboard tests and the production build.
   Verify anonymous sign-in, token refresh, and leaderboard reads with the new key.
   Check that unlisted or missing referrers are rejected.
4. Deploy Hosting and verify that the live app serves the replacement key and
   connects to Firestore. Deploy from a clean checkout if other work is in progress.
5. Delete the exposed key in Google Cloud. Confirm that a request using it fails
   with `API_KEY_INVALID` before resolving the alert as `revoked`.
6. Review Cloud Audit Logs and API request metrics for the exposed key's UID.
   Record the review's time range and visibility limits. Do not claim that an
   absence of suspicious audit entries proves that no data was accessed.

An already-open page may need a reload after the old key is revoked. Rebuild
older releases with the replacement key before rolling back Hosting.

## 2026-10-26 alert resolution

[GitHub secret-scanning alert #1](https://github.com/TypoStudio/typhoon-lab/security/secret-scanning/1)
identified the old browser key in historical commit `453db61`. The current source
already read configuration from environment variables.

- Created the restricted replacement at `2026-10-26T13:03:17Z` and updated the
  ignored local environment.
- Built and deployed committed revision `955ab0e` to Firebase Hosting. Verified
  the replacement is served on the custom domain and both default Firebase hosts;
  the current main bundle no longer contains the old key.
- Deleted old key resource `3b41460b-b09f-421a-b3ee-d8c5cfef69d8` at
  `2026-10-26T13:07:41Z`. A subsequent Google request returned HTTP 400 with
  `API_KEY_INVALID`, while the replacement returned HTTP 200.
- Resolved the GitHub alert as `revoked` after checking the old key was rejected.
- Validation: 20 Firebase configuration and leaderboard unit tests passed;
  TypeScript and the production build passed. Anonymous sign-in, token refresh,
  Firestore reads, unlisted/missing referrer rejection, and the leaderboard in
  local-preview and live-production browsers passed. Temporary verification
  accounts were deleted. No screenshots were captured.

The pre-rotation review covered the key's lifetime from
`2026-10-25T09:22Z` through approximately `2026-10-26T13:03Z`. The 50 available
audit entries contained project-owner and Google service-agent activity. Two
setup failures concerned a missing initial rules release and a service account
not yet created. Key-specific request metrics contained only Firestore (110 HTTP
200 and 3 HTTP 409 responses), Identity Toolkit (78 HTTP 200 responses), and
Secure Token (5 HTTP 200 responses).

No clear indication of misuse was found in that evidence. Only Admin Activity
audit logs were returned; no Data Access entries were available. These logs and
aggregate metrics cannot rule out unauthorized client activity or identify every
person who accessed public leaderboard data.
