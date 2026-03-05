import { describe, it, expect } from 'vitest';
import {
  SECRET_CATALOG,
  SECRET_CATALOG_MAP,
  ALL_SECRET_FIELD_KEYS,
  FIELD_KEY_TO_ENV_VAR,
  FIELD_KEY_TO_ENTRY,
  getEntriesByCategory,
} from '../catalog.js';
import { validateFieldValue } from '../validation.js';
import type { SecretIconKey } from '../types.js';

describe('Secret Catalog', () => {
  describe('Uniqueness constraints', () => {
    it('all entry IDs are unique', () => {
      const ids = SECRET_CATALOG.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('all field keys are unique across entries', () => {
      const keys = SECRET_CATALOG.flatMap(e => e.fields.map(f => f.key));
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('all env var names are unique across entries', () => {
      const envVars = SECRET_CATALOG.flatMap(e => e.fields.map(f => f.envVar));
      expect(new Set(envVars).size).toBe(envVars.length);
    });
  });

  describe('Icon validation', () => {
    it('all icon values are valid SecretIconKey members', () => {
      const validIcons: Set<SecretIconKey> = new Set(['send', 'discord', 'slack', 'key']);
      for (const entry of SECRET_CATALOG) {
        expect(validIcons.has(entry.icon)).toBe(true);
      }
    });
  });

  describe('Field constraints', () => {
    it('all fields have explicit maxLength', () => {
      for (const entry of SECRET_CATALOG) {
        for (const field of entry.fields) {
          expect(field.maxLength, `${entry.id}.${field.key} missing maxLength`).toBeDefined();
        }
      }
    });
  });

  describe('Validation patterns', () => {
    it('all validation patterns compile as valid regex', () => {
      for (const entry of SECRET_CATALOG) {
        for (const field of entry.fields) {
          if (field.validationPattern) {
            const pattern = field.validationPattern;
            expect(() => new RegExp(pattern)).not.toThrow();
          }
        }
      }
    });

    it(
      'no validation pattern exhibits catastrophic backtracking',
      { timeout: 1000 },
      () => {
        const longString = 'a'.repeat(10000);
        for (const entry of SECRET_CATALOG) {
          for (const field of entry.fields) {
            if (field.validationPattern) {
              const pattern = field.validationPattern;
              const regex = new RegExp(pattern);
              // Test completes quickly if no catastrophic backtracking
              const result = regex.test(longString);
              // Assert something to make the test meaningful
              expect(typeof result).toBe('boolean');
            }
          }
        }
      }
    );
  });

  describe('Field to env var mappings', () => {
    it('FIELD_KEY_TO_ENV_VAR covers all known channel env vars', () => {
      const knownEnvVars = new Set([
        'TELEGRAM_BOT_TOKEN',
        'DISCORD_BOT_TOKEN',
        'SLACK_BOT_TOKEN',
        'SLACK_APP_TOKEN',
      ]);

      const catalogEnvVars = new Set(FIELD_KEY_TO_ENV_VAR.values());

      for (const envVar of knownEnvVars) {
        expect(catalogEnvVars.has(envVar)).toBe(true);
      }
    });

    it('FIELD_KEY_TO_ENV_VAR has correct mappings', () => {
      expect(FIELD_KEY_TO_ENV_VAR.get('telegramBotToken')).toBe('TELEGRAM_BOT_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('discordBotToken')).toBe('DISCORD_BOT_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('slackBotToken')).toBe('SLACK_BOT_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('slackAppToken')).toBe('SLACK_APP_TOKEN');
    });
  });

  describe('Lookup helpers', () => {
    it('SECRET_CATALOG_MAP contains all entries by ID', () => {
      expect(SECRET_CATALOG_MAP.size).toBe(SECRET_CATALOG.length);
      for (const entry of SECRET_CATALOG) {
        expect(SECRET_CATALOG_MAP.get(entry.id)).toBe(entry);
      }
    });

    it('ALL_SECRET_FIELD_KEYS contains all field keys', () => {
      const expectedKeys = SECRET_CATALOG.flatMap(e => e.fields.map(f => f.key));
      expect(ALL_SECRET_FIELD_KEYS.size).toBe(expectedKeys.length);
      for (const key of expectedKeys) {
        expect(ALL_SECRET_FIELD_KEYS.has(key)).toBe(true);
      }
    });

    it('FIELD_KEY_TO_ENTRY maps field keys to owning entries', () => {
      expect(FIELD_KEY_TO_ENTRY.get('telegramBotToken')?.id).toBe('telegram');
      expect(FIELD_KEY_TO_ENTRY.get('discordBotToken')?.id).toBe('discord');
      expect(FIELD_KEY_TO_ENTRY.get('slackBotToken')?.id).toBe('slack');
      expect(FIELD_KEY_TO_ENTRY.get('slackAppToken')?.id).toBe('slack');
    });
  });

  describe('getEntriesByCategory', () => {
    it('returns all channel entries sorted by order', () => {
      const channels = getEntriesByCategory('channel');
      expect(channels.length).toBe(3);
      expect(channels[0].id).toBe('telegram');
      expect(channels[1].id).toBe('discord');
      expect(channels[2].id).toBe('slack');
    });

    it('returns empty array for categories with no entries', () => {
      const tools = getEntriesByCategory('tool');
      expect(tools).toEqual([]);
    });
  });

  describe('validateFieldValue', () => {
    it('accepts valid Telegram tokens', () => {
      const pattern = '^\\d{8,10}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue('123456789:ABCDefGhIJKlmnOPQrstUVWXYZ123456', pattern)).toBe(true);
    });

    it('rejects invalid Telegram tokens', () => {
      const pattern = '^\\d{8,10}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue('invalid', pattern)).toBe(false);
      expect(validateFieldValue('123:short', pattern)).toBe(false);
    });

    it('accepts valid Discord tokens', () => {
      const pattern = '^[A-Za-z\\d_-]{24,}?\\.[A-Za-z\\d_-]{4,}\\.[A-Za-z\\d_-]{25,}$';
      expect(
        validateFieldValue(
          'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM.ABCD.abcdefghijklmnopqrstuvwxyz',
          pattern
        )
      ).toBe(true);
    });

    it('rejects invalid Discord tokens', () => {
      const pattern = '^[A-Za-z\\d_-]{24,}?\\.[A-Za-z\\d_-]{4,}\\.[A-Za-z\\d_-]{25,}$';
      expect(validateFieldValue('invalid', pattern)).toBe(false);
      expect(validateFieldValue('short.ab.cd', pattern)).toBe(false);
    });

    it('accepts valid Slack bot tokens', () => {
      const pattern = '^xoxb-[A-Za-z0-9-]{20,255}$';
      // Use clearly fake token to avoid GitHub push protection false positives
      expect(validateFieldValue('xoxb-FAKE-TEST-TOKEN-abcdefghijklmnopqrst', pattern)).toBe(true);
    });

    it('rejects invalid Slack bot tokens', () => {
      const pattern = '^xoxb-[A-Za-z0-9-]{20,255}$';
      expect(validateFieldValue('xoxp-invalid', pattern)).toBe(false);
      expect(validateFieldValue('xoxb-short', pattern)).toBe(false);
    });

    it('accepts valid Slack app tokens', () => {
      const pattern = '^xapp-[A-Za-z0-9-]{20,255}$';
      // Use clearly fake token to avoid GitHub push protection false positives
      expect(validateFieldValue('xapp-FAKE-TEST-TOKEN-abcdefghijklmnopqrst', pattern)).toBe(true);
    });

    it('rejects invalid Slack app tokens', () => {
      const pattern = '^xapp-[A-Za-z0-9-]{20,255}$';
      expect(validateFieldValue('xoxb-invalid', pattern)).toBe(false);
      expect(validateFieldValue('xapp-short', pattern)).toBe(false);
    });

    it('rejects empty strings', () => {
      const pattern = '^\\d{8,10}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue('', pattern)).toBe(false);
    });

    it('accepts null (no validation needed)', () => {
      const pattern = '^\\d{8,10}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue(null, pattern)).toBe(true);
    });

    it('accepts undefined (no validation needed)', () => {
      const pattern = '^\\d{8,10}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue(undefined, pattern)).toBe(true);
    });

    it('accepts any value when no pattern is provided', () => {
      expect(validateFieldValue('anything', undefined)).toBe(true);
    });

    it('throws error for invalid regex patterns', () => {
      const invalidPattern = '[unclosed';
      expect(() => validateFieldValue('test', invalidPattern)).toThrow(
        /Invalid validation pattern in catalog/
      );
    });
  });
});
