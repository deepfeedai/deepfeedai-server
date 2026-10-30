FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
USER node
CMD ["node", "-r", "tsx/cjs", "--test", "--test-concurrency=1", "tests/acceptance/publishing.test.js"]
