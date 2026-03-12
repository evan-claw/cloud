import { describe, it, expect } from '@jest/globals';
import { buildUpstreamBody, stripModelPrefix } from './embedding-request';

describe('buildUpstreamBody', () => {
  describe('mistral provider', () => {
    it('should include model and input, strip OpenRouter-only fields', () => {
      const result = buildUpstreamBody(
        {
          model: 'mistral-embed',
          input: 'hello',
          user: 'user-123',
          provider: { order: ['Mistral'] },
          input_type: 'search_query',
        },
        'mistral'
      );

      expect(result).toEqual({ model: 'mistral-embed', input: 'hello' });
      expect(result).not.toHaveProperty('user');
      expect(result).not.toHaveProperty('provider');
      expect(result).not.toHaveProperty('input_type');
      expect(result).not.toHaveProperty('dimensions');
    });

    it('should pass through encoding_format when present', () => {
      const result = buildUpstreamBody(
        { model: 'mistral-embed', input: 'hello', encoding_format: 'base64' },
        'mistral'
      );

      expect(result.encoding_format).toBe('base64');
    });

    it('should pass through output_dimension when present', () => {
      const result = buildUpstreamBody(
        { model: 'mistral-embed', input: 'hello', output_dimension: 256 },
        'mistral'
      );

      expect(result.output_dimension).toBe(256);
    });

    it('should map dimensions to output_dimension when output_dimension is not set', () => {
      const result = buildUpstreamBody(
        { model: 'mistral-embed', input: 'hello', dimensions: 512 },
        'mistral'
      );

      expect(result.output_dimension).toBe(512);
      expect(result).not.toHaveProperty('dimensions');
    });

    it('should prefer output_dimension over dimensions when both are set', () => {
      const result = buildUpstreamBody(
        { model: 'mistral-embed', input: 'hello', dimensions: 512, output_dimension: 256 },
        'mistral'
      );

      expect(result.output_dimension).toBe(256);
      expect(result).not.toHaveProperty('dimensions');
    });

    it('should pass through output_dtype when present', () => {
      const result = buildUpstreamBody(
        { model: 'mistral-embed', input: 'hello', output_dtype: 'int8' },
        'mistral'
      );

      expect(result.output_dtype).toBe('int8');
    });

    it('should omit optional fields when not provided', () => {
      const result = buildUpstreamBody({ model: 'mistral-embed', input: 'hello' }, 'mistral');

      expect(Object.keys(result)).toEqual(['model', 'input']);
    });
  });

  describe('openai provider', () => {
    it('should include model and input, strip Mistral-only and routing fields', () => {
      const result = buildUpstreamBody(
        {
          model: 'text-embedding-3-small',
          input: 'hello',
          provider: { order: ['OpenAI'] },
          input_type: 'search_query',
          output_dtype: 'int8',
          output_dimension: 256,
        },
        'openai'
      );

      expect(result).toEqual({ model: 'text-embedding-3-small', input: 'hello' });
      expect(result).not.toHaveProperty('provider');
      expect(result).not.toHaveProperty('input_type');
      expect(result).not.toHaveProperty('output_dtype');
      expect(result).not.toHaveProperty('output_dimension');
    });

    it('should pass through encoding_format, dimensions, and user when present', () => {
      const result = buildUpstreamBody(
        {
          model: 'text-embedding-3-small',
          input: 'hello',
          encoding_format: 'float',
          dimensions: 1536,
          user: 'user-abc',
        },
        'openai'
      );

      expect(result.encoding_format).toBe('float');
      expect(result.dimensions).toBe(1536);
      expect(result.user).toBe('user-abc');
    });

    it('should omit optional fields when not provided', () => {
      const result = buildUpstreamBody(
        { model: 'text-embedding-3-small', input: 'hello' },
        'openai'
      );

      expect(Object.keys(result)).toEqual(['model', 'input']);
    });
  });

  describe('openrouter provider', () => {
    it('should forward all fields except output_dtype and output_dimension', () => {
      const result = buildUpstreamBody(
        {
          model: 'google/text-embedding-004',
          input: ['text1', 'text2'],
          encoding_format: 'float',
          dimensions: 768,
          user: 'user-hash',
          provider: { order: ['Google'] },
          input_type: 'search_document',
          output_dtype: 'int8',
          output_dimension: 256,
        },
        'openrouter'
      );

      expect(result).toEqual({
        model: 'google/text-embedding-004',
        input: ['text1', 'text2'],
        encoding_format: 'float',
        dimensions: 768,
        user: 'user-hash',
        provider: { order: ['Google'] },
        input_type: 'search_document',
      });
      expect(result).not.toHaveProperty('output_dtype');
      expect(result).not.toHaveProperty('output_dimension');
    });
  });

  describe('vercel provider', () => {
    it('should behave the same as openrouter (strips Mistral-only fields)', () => {
      const result = buildUpstreamBody(
        {
          model: 'openai/text-embedding-3-small',
          input: 'hello',
          output_dtype: 'float',
          output_dimension: 512,
        },
        'vercel'
      );

      expect(result).toEqual({ model: 'openai/text-embedding-3-small', input: 'hello' });
      expect(result).not.toHaveProperty('output_dtype');
      expect(result).not.toHaveProperty('output_dimension');
    });
  });
});

describe('stripModelPrefix', () => {
  it('should strip mistralai/ prefix', () => {
    expect(stripModelPrefix('mistralai/mistral-embed')).toBe('mistral-embed');
  });

  it('should strip openai/ prefix', () => {
    expect(stripModelPrefix('openai/text-embedding-3-small')).toBe('text-embedding-3-small');
  });

  it('should return model unchanged when no slash present', () => {
    expect(stripModelPrefix('mistral-embed')).toBe('mistral-embed');
  });

  it('should only strip the first prefix segment', () => {
    expect(stripModelPrefix('a/b/c')).toBe('b/c');
  });

  it('should handle empty string', () => {
    expect(stripModelPrefix('')).toBe('');
  });
});
