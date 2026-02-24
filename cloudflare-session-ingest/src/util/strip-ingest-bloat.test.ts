import { describe, expect, it } from 'vitest';
import { stripIngestBloat } from './strip-ingest-bloat';

describe('stripIngestBloat', () => {
  it('strips summary.diffs[].before and .after from session data', () => {
    const item = {
      type: 'session' as const,
      data: {
        id: 'ses_123',
        title: 'Test',
        summary: {
          additions: 10,
          deletions: 5,
          files: 2,
          diffs: [
            {
              file: 'a.ts',
              before: 'old content of a.ts...',
              after: 'new content of a.ts...',
              additions: 5,
              deletions: 3,
            },
            {
              file: 'b.ts',
              before: 'old content of b.ts...',
              after: 'new content of b.ts...',
              additions: 5,
              deletions: 2,
            },
          ],
        },
      },
    };

    const result = stripIngestBloat(item);
    const data = result.data as typeof item.data;

    expect(data.summary.diffs).toHaveLength(2);
    expect(data.summary.diffs[0].file).toBe('a.ts');
    expect(data.summary.diffs[0].additions).toBe(5);
    expect(data.summary.diffs[0]).not.toHaveProperty('before');
    expect(data.summary.diffs[0]).not.toHaveProperty('after');
    expect(data.summary.diffs[1]).not.toHaveProperty('before');
    expect(data.summary.diffs[1]).not.toHaveProperty('after');
  });

  it('strips metadata.diagnostics from part data', () => {
    const item = {
      type: 'part' as const,
      data: {
        id: 'prt_123',
        type: 'tool',
        tool: 'edit',
        state: {
          status: 'completed',
          metadata: {
            diff: 'some diff...',
            filediff: { file: 'a.ts', before: 'old', after: 'new', additions: 1, deletions: 1 },
            diagnostics: {
              '/project/a.ts': [{ severity: 1, message: 'err' }],
              '/project/b.ts': [{ severity: 1, message: 'unrelated' }],
            },
          },
        },
      },
    };

    const result = stripIngestBloat(item);
    const data = result.data as typeof item.data;

    expect(data.state.metadata).not.toHaveProperty('diagnostics');
    expect(data.state.metadata.diff).toBe('some diff...');
  });

  it('strips metadata.filediff.before and .after from part data', () => {
    const item = {
      type: 'part' as const,
      data: {
        id: 'prt_123',
        type: 'tool',
        state: {
          status: 'completed',
          metadata: {
            filediff: {
              file: 'a.ts',
              before: 'x'.repeat(50000),
              after: 'y'.repeat(50000),
              additions: 10,
              deletions: 5,
            },
          },
        },
      },
    };

    const result = stripIngestBloat(item);
    const data = result.data as typeof item.data;

    expect(data.state.metadata.filediff.file).toBe('a.ts');
    expect(data.state.metadata.filediff.additions).toBe(10);
    expect(data.state.metadata.filediff.deletions).toBe(5);
    expect(data.state.metadata.filediff).not.toHaveProperty('before');
    expect(data.state.metadata.filediff).not.toHaveProperty('after');
  });

  it('passes through non-session non-part items unchanged', () => {
    const item = { type: 'kilo_meta' as const, data: { platform: 'vscode' } };
    const result = stripIngestBloat(item);
    expect(result).toEqual(item);
  });

  it('passes through message items unchanged', () => {
    const item = {
      type: 'message' as const,
      data: { id: 'msg_123', role: 'assistant', summary: { diffs: [{ before: 'x', after: 'y' }] } },
    };
    const result = stripIngestBloat(item);
    const data = result.data as typeof item.data;
    expect(data.summary.diffs[0].before).toBe('x');
  });

  it('handles part without metadata gracefully', () => {
    const item = {
      type: 'part' as const,
      data: { id: 'prt_123', type: 'text', text: 'hello' },
    };
    const result = stripIngestBloat(item);
    expect(result).toEqual(item);
  });

  it('handles session without summary gracefully', () => {
    const item = {
      type: 'session' as const,
      data: { id: 'ses_123', title: 'No summary' },
    };
    const result = stripIngestBloat(item);
    expect(result).toEqual(item);
  });

  it('handles session with summary but no diffs', () => {
    const item = {
      type: 'session' as const,
      data: { id: 'ses_123', title: 'Test', summary: { additions: 1, deletions: 0, files: 1 } },
    };
    const result = stripIngestBloat(item);
    expect(result).toEqual(item);
  });

  it('does not mutate the original item', () => {
    const item = {
      type: 'part' as const,
      data: {
        id: 'prt_123',
        type: 'tool',
        state: {
          status: 'completed',
          metadata: {
            diagnostics: { '/a.ts': [{ severity: 1, message: 'err' }] },
            filediff: { file: 'a.ts', before: 'old', after: 'new' },
          },
        },
      },
    };

    const original = JSON.parse(JSON.stringify(item));
    stripIngestBloat(item);
    expect(item).toEqual(original);
  });
});
