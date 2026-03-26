#!/usr/bin/env bash
set -euo pipefail

TARGET_PORT=${PORT:-3000}

# Find an available port starting from TARGET_PORT (same behavior as Next.js auto-increment).
# Uses Node.js stdlib only — no external dependencies.
PORT=$(node -e "
  const net = require('net');
  function tryPort(port, retries) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && retries > 0) {
          resolve(tryPort(port + 1, retries - 1));
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port);
    });
  }
  tryPort(${TARGET_PORT}, 10).then(p => console.log(p));
")

echo "$PORT" > .dev-port
echo "Dev server starting on port $PORT (written to .dev-port)"

export PORT
export NEXTAUTH_URL="http://localhost:$PORT"
exec npx next dev -p "$PORT" "$@"
