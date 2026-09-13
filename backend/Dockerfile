FROM node:24-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
RUN pnpm install --frozen-lockfile --prod --filter @medripple/backend...

COPY backend backend

ENV NODE_ENV=production
ENV BACKEND_HOST=0.0.0.0
ENV BACKEND_PORT=3001

EXPOSE 3001

CMD ["pnpm", "--filter", "@medripple/backend", "start"]

