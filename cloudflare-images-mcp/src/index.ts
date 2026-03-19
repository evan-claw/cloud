import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { z } from 'zod';
import { validateToken, type ImageMCPTokenClaims } from './auth/jwt';
import { logger } from './logger';
import { createR2Client } from './r2/client';
import { getImage } from './tools/get-image';
import { transferImage } from './tools/transfer-image';

function createMCPServer(env: Env, claims: ImageMCPTokenClaims): McpServer {
  const server = new McpServer({
    name: 'app-builder-images',
    version: '1.0.0',
  });

  const r2 = createR2Client({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
  });

  let bucketPublicUrls: Record<string, string>;
  try {
    bucketPublicUrls = JSON.parse(env.BUCKET_PUBLIC_URLS) as Record<string, string>;
  } catch {
    throw new Error('BUCKET_PUBLIC_URLS env var is not valid JSON');
  }

  server.tool(
    'transfer_image',
    'Transfer an uploaded image to permanent public storage. Returns a public URL for use in <img> tags or CSS.',
    {
      sourcePath: z
        .string()
        .describe(
          'The sourcePath of the uploaded image (from the <available_images> block in the user message)'
        ),
    },
    async ({ sourcePath }) => {
      try {
        const publicUrl = await transferImage({ sourcePath, claims, r2, bucketPublicUrls });
        return { content: [{ type: 'text' as const, text: publicUrl }] };
      } catch (error) {
        logger.error('transfer_image tool error', { error: error instanceof Error ? error.message : String(error), sourcePath });
        throw error;
      }
    }
  );

  server.tool(
    'get_image',
    'Retrieve an uploaded image for visual analysis. Returns the image content so you can see what the image looks like.',
    {
      sourcePath: z
        .string()
        .describe(
          'The sourcePath of the uploaded image (from the <available_images> block in the user message)'
        ),
    },
    async ({ sourcePath }) => {
      try {
        const imageContent = await getImage({ sourcePath, claims, r2 });
        return {
          content: [
            {
              type: 'image' as const,
              data: imageContent.data,
              mimeType: imageContent.mimeType,
            },
          ],
        };
      } catch (error) {
        logger.error('get_image tool error', { error: error instanceof Error ? error.message : String(error), sourcePath });
        throw error;
      }
    }
  );

  return server;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function withCorsHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only POST is supported for Streamable HTTP transport
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Validate JWT from Authorization header
    const authHeader = request.headers.get('Authorization');
    let claims: ImageMCPTokenClaims;
    try {
      const secret = await env.NEXTAUTH_SECRET.get();
      if (!secret) {
        throw new Error('SECRET is not configured');
      }
      claims = validateToken(authHeader, secret);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      logger.warn('JWT validation failed', { error: message });
      return withCorsHeaders(
        new Response(JSON.stringify({ error: message }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    // Create a per-request MCP server scoped to this JWT's claims
    let server: McpServer | undefined;
    try {
      server = createMCPServer(env, claims);
    } catch (error) {
      logger.error('Failed to create MCP server', { error: error instanceof Error ? error.message : String(error) });
      return withCorsHeaders(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }

    // Use stateless StreamableHTTP transport (no session persistence needed)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    // Convert Fetch Request to Node-compatible req/res for the MCP SDK
    const { req, res } = toReqRes(request);
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error('MCP transport handler error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return withCorsHeaders(await toFetchResponse(res));
  },
} satisfies ExportedHandler<Env>;
