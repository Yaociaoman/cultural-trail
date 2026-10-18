# Cultural Trails API

All endpoints are served by the same Express origin as the existing `index.html`. JSON errors use `{ "error": "CODE", "message": "..." }`. Login state uses a random, server-stored session token in an `HttpOnly`, `SameSite=Strict` cookie. The browser never stores a password or session token in `localStorage`.

## Authentication

| Method | Path | Input | Result |
|---|---|---|---|
| `POST` | `/api/auth/register` | `{ "email", "username", "password" }` | `201 { user }`, sets session cookie |
| `POST` | `/api/auth/login` | `{ "email", "password" }` | `{ user }`, sets session cookie |
| `POST` | `/api/auth/logout` | empty JSON | `204`, invalidates current session |
| `GET` | `/api/auth/me` | — | `{ user }` |

Passwords must be 10–128 characters. Usernames must be 1–20 characters. Passwords are bcrypt-hashed. Auth endpoints are rate limited.

## Trail and stamps

| Method | Path | Input | Result |
|---|---|---|---|
| `GET` | `/api/locations` | — | Existing `data/locations.json` |
| `GET` | `/api/stamps` | authenticated | `{ stamps: [{ id, locationId, capturedAt, distanceM, createdAt, photoUrl }] }` |
| `POST` | `/api/stamps` | authenticated multipart form field `photo`; optional manual fields `manual=true` and `locationId` | `201 { stamp, points }` |
| `GET` | `/api/stamps/:locationId/photo` | authenticated | User-owned image bytes |

The server checks file type and size and reads EXIF on the server (JPEG/PNG/WebP/HEIC/HEIF). Automatic stamping requires GPS within 500 metres and a capture time within the last 48 hours. If GPS is missing or outside the range, the user may select a location and submit `manual=true` plus its `locationId`; this immediately awards the stamp and points without GPS verification. Manual submissions are recorded with `verificationMethod: "manual"`; the user must select a place they actually visited. One stamp per user and location; one use per identical photo hash per user. Adjust upload and age defaults in `.env` for the team's agreed policy. Images are stored outside public static access with randomized names; image reads require the owning session.

## Points and rewards

| Method | Path | Input | Result |
|---|---|---|---|
| `GET` | `/api/points` | authenticated | `{ points, entries }` (up to 200 ledger entries) |
| `GET` | `/api/rewards` | — | `{ rewards }` |
| `POST` | `/api/redemptions` | authenticated `{ "rewardId" }` | `201 { redemption }` |
| `GET` | `/api/redemptions` | authenticated | `{ redemptions }` |

Each verified stamp awards `POINTS_PER_STAMP` (10 by default). Redemption atomically checks stock and balance, decrements points, and records the matching negative ledger entry. The repository contains no real reward catalog, so the rewards table starts empty. Add only rewards approved by the team, for example:

```sql
INSERT INTO rewards(id,name,description,cost,stock)
VALUES ('local-market-coupon','在地市集折價券','請於合作店家出示此兌換紀錄',100,50);
```

## Security and deployment notes

- The API accepts same-origin browser requests; cross-origin `Origin` values are rejected. Keep HTTPS enabled in production (`NODE_ENV=production`) so the session cookie is marked `Secure`.
- Set appropriate reverse-proxy trust settings before deployment behind a proxy; do not expose the development server directly to the public internet.
- SQLite and uploaded photos are local persistent files. Back them up together. For multiple app instances, move sessions, database, and photo storage to shared production services.
- EXIF proves only that the uploaded file contains coordinates and a capture time. It does not cryptographically prove the photo is original or untampered with; this is a project demo anti-abuse check, not high-assurance identity/location proof.
- HEIC/HEIF EXIF is parsed on the server. Some browsers cannot preview HEIC directly; collection and verification still work. A thumbnail conversion can be added if the deployment's image codec supports HEIC.
