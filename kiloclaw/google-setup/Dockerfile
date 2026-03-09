FROM node:22-slim

# Install gws CLI
RUN npm install -g @anthropic/gws

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY setup.mjs ./

EXPOSE 8080

ENTRYPOINT ["node", "setup.mjs"]
