FROM node:22-slim

# Install gws CLI (Google Workspace CLI)
# TODO: Update package name once published. The gws CLI may be distributed as:
#   - npm: npm install -g @anthropic/gws
#   - direct binary download
# For now, this will fail at build time if the package doesn't exist yet.
RUN npm install -g @anthropic/gws || echo "WARN: gws CLI not available yet — build will succeed but setup will fail at runtime"

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY setup.mjs ./

EXPOSE 8080

ENTRYPOINT ["node", "setup.mjs"]
