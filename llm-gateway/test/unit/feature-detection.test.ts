// Tests for feature-detection: validateFeatureHeader.

import { describe, it, expect } from 'vitest';
import { validateFeatureHeader, FEATURE_VALUES } from '../../src/lib/feature-detection';

describe('validateFeatureHeader', () => {
  it('returns valid feature values', () => {
    expect(validateFeatureHeader('vscode-extension')).toBe('vscode-extension');
    expect(validateFeatureHeader('jetbrains-extension')).toBe('jetbrains-extension');
    expect(validateFeatureHeader('autocomplete')).toBe('autocomplete');
  });

  it('returns null for invalid values', () => {
    expect(validateFeatureHeader('unknown-tool')).toBeNull();
    expect(validateFeatureHeader('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(validateFeatureHeader(null)).toBeNull();
  });

  it('FEATURE_VALUES contains expected entries', () => {
    expect(FEATURE_VALUES).toContain('vscode-extension');
    expect(FEATURE_VALUES).toContain('jetbrains-extension');
    expect(FEATURE_VALUES).toContain('autocomplete');
  });
});
