// Tests for extract-headers: extractProjectHeaders, getFraudDetectionHeaders.

import { describe, it, expect } from 'vitest';
import { extractProjectHeaders, getFraudDetectionHeaders } from '../../src/lib/extract-headers';

describe('getFraudDetectionHeaders', () => {
  it('extracts geo data from cf object', () => {
    const headers = new Headers({
      'x-forwarded-for': '1.2.3.4',
      'user-agent': 'Kilo-Code/3.0.0',
    });
    const cf = {
      city: 'San Francisco',
      country: 'US',
      latitude: '37.7749',
      longitude: '-122.4194',
      botManagement: { ja3Hash: 'abc123' },
    };
    const result = getFraudDetectionHeaders(headers, cf);
    expect(result.http_x_forwarded_for).toBe('1.2.3.4');
    expect(result.geo_city).toBe('San Francisco');
    expect(result.geo_country).toBe('US');
    expect(result.geo_latitude).toBe(37.7749);
    expect(result.geo_longitude).toBe(-122.4194);
    expect(result.ja3_hash).toBe('abc123');
    expect(result.http_user_agent).toBe('Kilo-Code/3.0.0');
  });

  it('returns null when cf is undefined', () => {
    const result = getFraudDetectionHeaders(new Headers(), undefined);
    expect(result.http_x_forwarded_for).toBeNull();
    expect(result.geo_city).toBeNull();
    expect(result.geo_latitude).toBeNull();
    expect(result.ja3_hash).toBeNull();
  });

  it('returns null when cf has no botManagement (non-Enterprise)', () => {
    const cf = { city: 'Austin', country: 'US', latitude: '30.27', longitude: '-97.74' };
    const result = getFraudDetectionHeaders(new Headers(), cf);
    expect(result.geo_city).toBe('Austin');
    expect(result.ja3_hash).toBeNull();
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
    const result = extractProjectHeaders(headers, undefined);
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
    const result = extractProjectHeaders(headers, undefined);
    expect(result.projectId).toBe('my-repo');
  });

  it('normalizes SSH git URLs to repo name', () => {
    const headers = new Headers({
      'X-KiloCode-ProjectId': 'git@github.com:org/my-repo.git',
    });
    const result = extractProjectHeaders(headers, undefined);
    expect(result.projectId).toBe('my-repo');
  });

  it('returns 0 for missing version header', () => {
    const result = extractProjectHeaders(new Headers(), undefined);
    expect(result.numericKiloCodeVersion).toBe(0);
    expect(result.xKiloCodeVersion).toBeNull();
  });

  it('truncates long header values', () => {
    const longValue = 'x'.repeat(600);
    const headers = new Headers({
      'x-kilocode-taskid': longValue,
    });
    const result = extractProjectHeaders(headers, undefined);
    expect(result.taskId).toHaveLength(500);
  });
});
