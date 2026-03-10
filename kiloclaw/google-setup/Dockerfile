FROM node:22-slim

# Install dependencies for gcloud CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    apt-transport-https \
    ca-certificates \
    gnupg \
    expect \
  && rm -rf /var/lib/apt/lists/*

# Install gcloud CLI
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

# Install gws CLI (Google Workspace CLI)
# https://github.com/googleworkspace/cli
RUN npm install -g @googleworkspace/cli

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY setup.mjs ./

EXPOSE 8080

ENTRYPOINT ["node", "setup.mjs"]
