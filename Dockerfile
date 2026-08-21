FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY templates ./templates
COPY prompts ./prompts
COPY contracts ./contracts
COPY config ./config
COPY fixtures ./fixtures
RUN mkdir -p /data/artifacts
ENV NODE_ENV=production
ENV ARTIFACT_DIR=/data/artifacts
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
