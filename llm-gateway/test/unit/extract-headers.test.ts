// Tests for extract-headers: extractProjectHeaders, getFraudDetectionHeaders.

import { describe, it, expect } from 'vitest';
import { extractProjectHeaders, getFraudDetectionHeaders } from '../../src/lib/extract-headers';

describe('getFraudDetectionHeaders', () => {
  it('extracts all fraud detection headers', () => {
    const headers = new Headers({
      'x-forwarded-for': '1.2.3.4',
      'x-vercel-ip-city': 'San Francisco',
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-latitude': '37.7749',
      'x-vercel-ip-longitude': '-122.4194',
      'x-vercel-ja4-digest': 'abc123',
      'user-agent': 'Kilo-Code/3.0.0',
    });
    const result = getFraudDetectionHeaders(headers);
    expect(result.http_x_forwarded_for).toBe('1.2.3.4');
    expect(result.http_x_vercel_ip_city).toBe('San Francisco');
    expect(result.http_x_vercel_ip_country).toBe('US');
    expect(result.http_x_vercel_ip_latitude).toBe(37.7749);
    expect(result.http_x_vercel_ip_longitude).toBe(-122.4194);
    expect(result.http_x_vercel_ja4_digest).toBe('abc123');
    expect(result.http_user_agent).toBe('Kilo-Code/3.0.0');
  });

  it('returns null for missing headers', () => {
    const result = getFraudDetectionHeaders(new Headers());
    expect(result.http_x_forwarded_for).toBeNull();
    expect(result.http_x_vercel_ip_city).toBeNull();
    expect(result.http_x_vercel_ip_latitude).toBeNull();
  });
});

describe('extractProjectHeaders', () => {
  it('extracts all project headers', () => {
    const headers = new Headers({
      'X-KiloCode-Version': '3.2.1',
      'X-KiloCode-ProjectId': 'my-project',
      'x-kilocode-taskid': 'task-123',
      'x-kilocode-editorname': 'vscode',
      'x-kilocode-machineid': 'machine-abc',
      'x-forwarded-for': '5.6.7.8',
    });
    const result = extractProjectHeaders(headers);
    expect(result.xKiloCodeVersion).toBe('3.2.1');
    expect(result.projectId).toBe('my-project');
    expect(result.taskId).toBe('task-123');
    expect(result.editorName).toBe('vscode');
    expect(result.machineId).toBe('machine-abc');
    expect(result.numericKiloCodeVersion).toBeCloseTo(3.002001, 6);
    expect(result.fraudHeaders.http_x_forwarded_for).toBe('5.6.7.8');
  });

  it('normalizes git HTTPS URLs to repo name', () => {
    const headers = new Headers({
      'X-KiloCode-ProjectId': 'https://github.com/org/my-repo.git',
    });
    const result = extractProjectHeaders(headers);
    expect(result.projectId).toBe('my-repo');
  });

  it('normalizes SSH git URLs to repo name', () => {
    const headers = new Headers({
      'X-KiloCode-ProjectId': 'git@github.com:org/my-repo.git',
    });
    const result = extractProjectHeaders(headers);
    expect(result.projectId).toBe('my-repo');
  });

  it('returns 0 for missing version header', () => {
    const result = extractProjectHeaders(new Headers());
    expect(result.numericKiloCodeVersion).toBe(0);
    expect(result.xKiloCodeVersion).toBeNull();
  });

  it('truncates long header values', () => {
    const longValue = 'x'.repeat(600);
    const headers = new Headers({
      'x-kilocode-taskid': longValue,
    });
    const result = extractProjectHeaders(headers);
    expect(result.taskId).toHaveLength(500);
  });
});
