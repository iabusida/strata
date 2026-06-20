# Environment Separation Guide

## Local Development

To set up local development with a local PostgreSQL database:

### 1. Install PostgreSQL

```bash
# macOS with Homebrew
brew install postgresql

# Start PostgreSQL
brew services start postgresql
```

### 2. Create local database

```bash
createuser -P hype_user  # password: hype_dev_password (or choose your own)
createdb -O hype_user hype_trading
```

### 3. Update .env.local

The `.env.local` file is already created with:
- `DATABASE_URL=postgresql://hype_user:hype_dev_password@localhost:5432/hype_trading?schema=public`
- `LIVE_TRADING_ENABLED=false` (safer for local testing)

Adjust the password in `.env.local` if you chose a different one.

### 4. Run migrations

```bash
cd apps/api
npm run prisma:migrate:dev
# or
npm run prisma:generate
```

### 5. Start local development

```bash
npm run dev:api    # Runs against local PostgreSQL
npm run dev:web    # Runs web against local API
```

## Production Deployment

### Fly.io (strata-api)

The production API uses **Neon** (managed PostgreSQL) via Fly secret:

1. **Database is stored in Fly secrets**, not in code
   ```bash
   # View current secret (requires Fly auth)
   flyctl secrets list -a strata-api
   
   # Set/update Neon DATABASE_URL (if needed)
   flyctl secrets set DATABASE_URL="postgresql://..." -a strata-api
   ```

2. **No sensitive data in committed files**
   - `.env` is for non-sensitive config only
   - `.env.local` is git-ignored (for local dev)
   - `apps/api/.env` is now placeholder-only
   - Secrets are managed via Fly CLI

3. **Current production database**
   - Provider: Neon (PostgreSQL)
   - Region: us-east-1
   - Endpoint: ep-red-waterfall-aiu7lm6t-pooler.c-4.us-east-1.aws.neon.tech

### Vercel (web-livid-eta-15.vercel.app)

The web frontend uses environment variables set in Vercel project:
- `NEXT_PUBLIC_API_BASE_URL=https://strata-api.fly.dev`
- `NEXT_PUBLIC_AUTH_DISABLED=true`

These are **only for the web frontend**; database access is via the Fly API.

## Database Isolation

| Environment | Database | Host | Status |
|---|---|---|---|
| Local dev | PostgreSQL | localhost:5432 | Isolated - local data only |
| Production (Fly) | Neon | AWS us-east-1 | Production data |
| Vercel | None | None | Frontend only, uses Fly API |

**Important**: Data is never mixed between local and production:
- Local dev uses `.env.local` with local PostgreSQL
- Production uses Fly secret with Neon
- Vercel only serves the UI

## Troubleshooting

### "connection refused" when running npm run dev:api

Check if PostgreSQL is running:
```bash
brew services list
# Should show: postgresql started

# If not running, start it:
brew services start postgresql
```

### "database does not exist"

Create the database:
```bash
createdb -O hype_user hype_trading
```

### "password authentication failed"

Check `.env.local` DATABASE_URL matches your PostgreSQL credentials:
```bash
# Test connection
psql postgresql://hype_user:hype_dev_password@localhost:5432/hype_trading
```

### Prisma migration errors

Ensure `.env.local` is loaded (it should be auto-loaded by dotenv):
```bash
cd apps/api
npm run prisma:migrate:dev
```

## File Structure Reference

```
hype-trading/
├── .env                    # Shared config (NO database URL)
├── .env.local             # Local dev only (git-ignored)
│   └── DATABASE_URL=postgresql://...@localhost:5432/...
├── apps/
│   ├── api/
│   │   ├── .env           # API placeholder
│   │   └── .env.local     # API local dev (git-ignored)
│   │       └── DATABASE_URL=postgresql://...@localhost:5432/...
│   └── web/
│       └── .vercel/       # Vercel project config
└── fly.toml               # Fly.io config (uses Fly secret for DB)
```
