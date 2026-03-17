import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { registerFileRoutes } from './files';

vi.mock('node:fs', () => ({
  default: {
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    statSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p), // identity by default (no symlinks)
  },
}));

vi.mock('../atomic-write', () => ({
  atomicWrite: vi.fn(),
}));

vi.mock('../backup-file', () => ({
  backupFile: vi.fn(),
}));

import fs from 'node:fs';
import { atomicWrite } from '../atomic-write';
import { backupFile } from '../backup-file';

const TOKEN = 'test-token';
const ROOT = '/root/.openclaw';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

function mockDirent(name: string, isDir: boolean, isSymlink = false) {
  return {
    name,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isFile: () => !isDir && !isSymlink,
  };
}

function flattenNames(nodes: any[]): string[] {
  return nodes.flatMap((n: any) => [n.name, ...(n.children ? flattenNames(n.children) : [])]);
}

describe('file routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    registerFileRoutes(app, TOKEN, ROOT);
  });

  describe('auth', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await app.request('/_kilo/files/tree');
      expect(res.status).toBe(401);
    });

    it('rejects wrong token', async () => {
      const res = await app.request('/_kilo/files/tree', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /_kilo/files/tree', () => {
    it('returns recursive directory listing', async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
        if (dir === ROOT) {
          return [
            { name: 'openclaw.json', isDirectory: () => false, isSymbolicLink: () => false },
            { name: 'workspace', isDirectory: () => true, isSymbolicLink: () => false },
            { name: 'credentials', isDirectory: () => true, isSymbolicLink: () => false },
          ] as any;
        }
        if (dir === `${ROOT}/workspace`) {
          return [
            { name: 'SOUL.md', isDirectory: () => false, isSymbolicLink: () => false },
          ] as any;
        }
        return [];
      });

      const res = await app.request('/_kilo/files/tree', { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.tree).toHaveLength(2);
      expect(body.tree[0]).toEqual({
        name: 'openclaw.json',
        path: 'openclaw.json',
        type: 'file',
      });
      expect(body.tree[1].name).toBe('workspace');
      expect(body.tree[1].children[0].name).toBe('SOUL.md');
    });

    it('filters out .bak and .kilotmp files', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'SOUL.md', isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'SOUL.md.bak.2026-03-01', isDirectory: () => false, isSymbolicLink: () => false },
        {
          name: '.openclaw.json.kilotmp.abc',
          isDirectory: () => false,
          isSymbolicLink: () => false,
        },
      ] as any);

      const res = await app.request('/_kilo/files/tree', { headers: authHeaders() });
      const body = (await res.json()) as any;
      expect(body.tree).toHaveLength(1);
      expect(body.tree[0].name).toBe('SOUL.md');
    });
  });

  describe('GET /_kilo/files/read', () => {
    it('reads a file and returns content with etag', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('# My Agent');

      const res = await app.request('/_kilo/files/read?path=workspace/SOUL.md', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.content).toBe('# My Agent');
      expect(body.etag).toBeDefined();
    });

    it('rejects disallowed extensions', async () => {
      const res = await app.request('/_kilo/files/read?path=workspace/image.png', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });

    it('rejects path traversal', async () => {
      const res = await app.request('/_kilo/files/read?path=../etc/passwd', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for missing file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const res = await app.request('/_kilo/files/read?path=workspace/SOUL.md', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it('rejects symlinks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);

      const res = await app.request('/_kilo/files/read?path=workspace/linked.md', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /_kilo/files/write', () => {
    it('writes a file with backup', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('old content');

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: 'workspace/SOUL.md',
          content: 'new content',
        }),
      });
      expect(res.status).toBe(200);
      expect(backupFile).toHaveBeenCalledWith(`${ROOT}/workspace/SOUL.md`);
      expect(atomicWrite).toHaveBeenCalledWith(`${ROOT}/workspace/SOUL.md`, 'new content');

      const body = (await res.json()) as any;
      expect(body.etag).toBeDefined();
    });

    it('returns 404 for non-existent file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: 'workspace/NEW.md',
          content: 'content',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 on etag mismatch', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('current content');

      const res = await app.request('/_kilo/files/write', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: 'workspace/SOUL.md',
          content: 'new content',
          etag: 'wrong-etag',
        }),
      });
      expect(res.status).toBe(409);

      const body = (await res.json()) as any;
      expect(body.code).toBe('file_etag_conflict');
    });
  });

  describe('admin mode', () => {
    it('GET /_kilo/files/tree?mode=admin returns unfiltered tree', async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: any) => {
        if (dir === ROOT) {
          return [
            mockDirent('openclaw.json', false),
            mockDirent('credentials', true),
            mockDirent('SOUL.md.bak.2026-03-01', false),
            mockDirent('debug.log', false),
          ] as any;
        }
        if (dir === `${ROOT}/credentials`) {
          return [mockDirent('token.txt', false)] as any;
        }
        return [];
      });

      const res = await app.request('/_kilo/files/tree?mode=admin', { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      const names = flattenNames(body.tree);
      expect(names).toContain('credentials');
      expect(names).toContain('token.txt');
      expect(names).toContain('SOUL.md.bak.2026-03-01');
      expect(names).toContain('debug.log');
    });

    it('GET /_kilo/files/read?mode=admin reads files with non-allowed extensions', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('log content');

      const res = await app.request('/_kilo/files/read?path=debug.log&mode=admin', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.content).toBe('log content');
    });

    it('POST /_kilo/files/write?mode=admin writes files with non-allowed extensions', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.lstatSync).mockReturnValue({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as any);

      const res = await app.request('/_kilo/files/write?mode=admin', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: 'debug.log', content: 'new log content' }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.etag).toBeDefined();
    });

    it('path traversal still rejected in admin mode', async () => {
      const res = await app.request('/_kilo/files/read?path=../etc/passwd&mode=admin', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });
  });
});
