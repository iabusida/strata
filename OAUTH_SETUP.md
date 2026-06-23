# OAuth Configuration Guide

This application uses NextAuth.js for Google and Apple OAuth authentication.

## Setting up OAuth Providers

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the Google+ API
4. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/callback/google`
     - `https://stratatrading.app/api/auth/callback/google`
5. Copy the Client ID and Client Secret

Add to your `.env.local`:
```
GOOGLE_CLIENT_ID=your-client-id-here
GOOGLE_CLIENT_SECRET=your-client-secret-here
NEXTAUTH_SECRET=your-random-secret-here
NEXTAUTH_URL=http://localhost:3000
```

Generate a random secret:
```bash
openssl rand -base64 32
```

### Apple Sign-In (Optional)

Apple Sign-In support is available but not currently enabled. To add it later:

1. Go to [Apple Developer Account](https://developer.apple.com/)
2. Create Service ID and Private Key
3. Configure Return URLs:
   - `http://localhost:3000/api/auth/callback/apple`
   - `https://stratatrading.app/api/auth/callback/apple`
4. Add to `.env.local` and uncomment AppleProvider in `apps/web/lib/auth-config.ts`

## Database Setup

The application uses Prisma ORM with PostgreSQL. The OAuth migration adds:
- `Account` table: stores OAuth provider credentials
- `Session` table: manages NextAuth sessions
- `VerificationToken` table: for email verification (if needed)
- Updated `User` model: `passwordHash` is now optional, added `image` and `emailVerified` fields

Run migrations:
```bash
npm run prisma:deploy
```

## Disabling Local Authentication

When ready to remove email/password authentication:
1. Remove the `CredentialsProvider` from `apps/web/lib/auth-config.ts`
2. Remove email/password form from `apps/web/app/login/page.tsx`
3. Make `passwordHash` field required again in Prisma schema (if desired)
4. Remove `/api/auth/login` and `/api/auth/signup` endpoints from API (apps/api/src/routes/auth-api.ts)

## Testing OAuth Locally

1. Use ngrok or similar to expose your localhost:3000 to the internet
2. Update Google/Apple redirect URIs to use the ngrok URL
3. Set `NEXTAUTH_URL` to the ngrok URL
4. Test OAuth flows through the login page
