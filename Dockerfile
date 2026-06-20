FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json ./
COPY apps/api/package.json ./apps/api/package.json

# Install API workspace dependencies using a clean npm config to avoid host auth leakage
ENV NPM_CONFIG_USERCONFIG=/tmp/.npmrc
RUN printf "registry=https://registry.npmjs.org/\nalways-auth=false\n" > /tmp/.npmrc \
	&& npm install --workspace @strata/api --include-workspace-root=false --package-lock=false --no-audit --fund=false

# Copy prisma schema
COPY apps/api/prisma ./apps/api/prisma

# Generate Prisma client
RUN npm --workspace @strata/api run prisma:generate

# Copy source code
COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/hl-candles.json ./apps/api/

# Expose API port
EXPOSE 8787

# Run migrations and then start API server
CMD ["sh", "-c", "npm --workspace @strata/api run prisma:deploy && npm --workspace @strata/api run start"]
