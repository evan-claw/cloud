import {
  redactOpenclawConfig,
  restoreRedactedSecrets,
  isSecretKey,
  REDACTED_PLACEHOLDER,
} from './config-redaction';

const FULL_CONFIG = {
  gateway: {
    port: 3001,
    mode: 'local',
    bind: 'loopback',
    auth: { token: 'super-secret-gateway-token' },
    controlUi: { allowedOrigins: ['https://app.kilo.ai'] },
  },
  channels: {
    telegram: { botToken: 'tg-bot-secret', enabled: true, dmPolicy: 'pairing' },
    discord: { token: 'discord-bot-secret', enabled: true },
    slack: { botToken: 'slack-bot-secret', appToken: 'slack-app-secret', enabled: true },
  },
  models: {
    providers: {
      kilocode: {
        baseUrl: 'https://api.kilo.ai/api/gateway/',
        apiKey: 'kilo-provider-api-key',
        api: 'openai-completions',
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-secret-key',
      },
    },
  },
  agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
  tools: { profile: 'full', exec: { host: 'gateway' } },
};

describe('redactOpenclawConfig', () => {
  it('replaces all secret fields with the redacted placeholder', () => {
    const redacted = redactOpenclawConfig(FULL_CONFIG);

    expect(redacted.gateway).toMatchObject({
      port: 3001,
      mode: 'local',
      auth: { token: REDACTED_PLACEHOLDER },
    });
    expect(redacted.channels).toMatchObject({
      telegram: { botToken: REDACTED_PLACEHOLDER, enabled: true },
      discord: { token: REDACTED_PLACEHOLDER, enabled: true },
      slack: {
        botToken: REDACTED_PLACEHOLDER,
        appToken: REDACTED_PLACEHOLDER,
        enabled: true,
      },
    });
  });

  it('preserves non-secret fields unchanged', () => {
    const redacted = redactOpenclawConfig(FULL_CONFIG);

    expect(redacted.agents).toEqual(FULL_CONFIG.agents);
    expect(redacted.tools).toEqual(FULL_CONFIG.tools);
    expect((redacted.gateway as Record<string, unknown>).port).toBe(3001);
    expect((redacted.gateway as Record<string, unknown>).controlUi).toEqual({
      allowedOrigins: ['https://app.kilo.ai'],
    });
  });

  it('does not mutate the original config', () => {
    const original = JSON.parse(JSON.stringify(FULL_CONFIG));
    redactOpenclawConfig(FULL_CONFIG);
    expect(FULL_CONFIG).toEqual(original);
  });

  it('handles config with no secrets present', () => {
    const minimal = { agents: { defaults: {} }, tools: { profile: 'full' } };
    const redacted = redactOpenclawConfig(minimal);
    expect(redacted).toEqual(minimal);
  });

  it('handles config with only some secrets present', () => {
    const partial = {
      gateway: { port: 3001, auth: { token: 'secret' } },
      channels: {},
    };
    const redacted = redactOpenclawConfig(partial);
    expect((redacted.gateway as Record<string, unknown>).auth).toEqual({
      token: REDACTED_PLACEHOLDER,
    });
    expect(redacted.channels).toEqual({});
  });

  it('does not redact empty string secrets', () => {
    const config = {
      gateway: { auth: { token: '' } },
    };
    const redacted = redactOpenclawConfig(config);
    expect((redacted.gateway as Record<string, unknown>).auth).toEqual({ token: '' });
  });

  it('redacts provider apiKey fields via pattern matching', () => {
    const redacted = redactOpenclawConfig(FULL_CONFIG);
    const providers = (redacted.models as Record<string, unknown>).providers as Record<
      string,
      Record<string, unknown>
    >;

    expect(providers.kilocode.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(providers.openai.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(providers.openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('redacts secret-shaped keys at arbitrary depth', () => {
    const config = {
      deeply: { nested: { provider: { apiKey: 'deep-secret', name: 'test' } } },
    };
    const redacted = redactOpenclawConfig(config);
    const provider = (
      (redacted.deeply as Record<string, unknown>).nested as Record<string, unknown>
    ).provider as Record<string, unknown>;
    expect(provider.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(provider.name).toBe('test');
  });
});

describe('restoreRedactedSecrets', () => {
  it('restores placeholder values from the current config', () => {
    const userConfig = redactOpenclawConfig(FULL_CONFIG);
    const merged = restoreRedactedSecrets(userConfig, FULL_CONFIG);

    expect(merged).toEqual(FULL_CONFIG);
  });

  it('keeps new values when the user changed a secret', () => {
    const userConfig = redactOpenclawConfig(FULL_CONFIG);
    ((userConfig.gateway as Record<string, unknown>).auth as Record<string, unknown>).token =
      'new-token';

    const merged = restoreRedactedSecrets(userConfig, FULL_CONFIG);
    expect(
      ((merged.gateway as Record<string, unknown>).auth as Record<string, unknown>).token
    ).toBe('new-token');
  });

  it('keeps field deleted when user removed a secret field', () => {
    const userConfig = redactOpenclawConfig(FULL_CONFIG);
    delete (userConfig.channels as Record<string, unknown>).telegram;

    const merged = restoreRedactedSecrets(userConfig, FULL_CONFIG);
    expect((merged.channels as Record<string, unknown>).telegram).toBeUndefined();
  });

  it('removes placeholder when original secret no longer exists', () => {
    const userConfig = {
      gateway: { auth: { token: REDACTED_PLACEHOLDER } },
    };
    const currentConfig = { gateway: { port: 3001 } };

    const merged = restoreRedactedSecrets(userConfig, currentConfig);
    expect(
      ((merged.gateway as Record<string, unknown>).auth as Record<string, unknown>).token
    ).toBeUndefined();
  });

  it('does not mutate the user config', () => {
    const userConfig = redactOpenclawConfig(FULL_CONFIG);
    const original = JSON.parse(JSON.stringify(userConfig));
    restoreRedactedSecrets(userConfig, FULL_CONFIG);
    expect(userConfig).toEqual(original);
  });

  it('handles empty configs gracefully', () => {
    const merged = restoreRedactedSecrets({}, {});
    expect(merged).toEqual({});
  });

  it('deletes placeholder when parent path is completely missing from current config', () => {
    const userConfig = {
      gateway: { auth: { token: REDACTED_PLACEHOLDER } },
    };
    const currentConfig = {};

    const merged = restoreRedactedSecrets(userConfig, currentConfig);
    // The placeholder should be deleted since there's no original secret to restore
    expect(
      ((merged.gateway as Record<string, unknown>).auth as Record<string, unknown>).token
    ).toBeUndefined();
  });

  it('restores provider apiKey placeholders from current config', () => {
    const userConfig = redactOpenclawConfig(FULL_CONFIG);
    const merged = restoreRedactedSecrets(userConfig, FULL_CONFIG);

    const providers = (merged.models as Record<string, unknown>).providers as Record<
      string,
      Record<string, unknown>
    >;
    expect(providers.kilocode.apiKey).toBe('kilo-provider-api-key');
    expect(providers.openai.apiKey).toBe('sk-openai-secret-key');
  });

  it('keeps new provider apiKey when user changed it', () => {
    const userConfig = redactOpenclawConfig(FULL_CONFIG);
    const providers = (userConfig.models as Record<string, unknown>).providers as Record<
      string,
      Record<string, unknown>
    >;
    providers.openai.apiKey = 'sk-new-key';

    const merged = restoreRedactedSecrets(userConfig, FULL_CONFIG);
    const mergedProviders = (merged.models as Record<string, unknown>).providers as Record<
      string,
      Record<string, unknown>
    >;
    expect(mergedProviders.openai.apiKey).toBe('sk-new-key');
    // kilocode apiKey should still be restored from original
    expect(mergedProviders.kilocode.apiKey).toBe('kilo-provider-api-key');
  });

  it('strips unresolvable placeholders in new subtrees not in currentConfig', () => {
    const userConfig = {
      models: {
        providers: {
          brandNewProvider: {
            apiKey: REDACTED_PLACEHOLDER,
            baseUrl: 'https://example.com',
          },
        },
      },
    };
    const currentConfig = {
      models: { providers: {} },
    };

    const merged = restoreRedactedSecrets(userConfig, currentConfig);
    const provider = (
      (merged.models as Record<string, unknown>).providers as Record<string, unknown>
    ).brandNewProvider as Record<string, unknown>;
    expect(provider.apiKey).toBeUndefined();
    expect(provider.baseUrl).toBe('https://example.com');
  });

  it('handles mixed: some placeholders, some new values, some removed', () => {
    const userConfig = {
      gateway: { port: 3001, auth: { token: REDACTED_PLACEHOLDER } },
      channels: {
        telegram: { botToken: 'brand-new-telegram-token', enabled: true },
        slack: { botToken: REDACTED_PLACEHOLDER, appToken: REDACTED_PLACEHOLDER, enabled: true },
      },
    };

    const merged = restoreRedactedSecrets(userConfig, FULL_CONFIG);

    // Gateway token: restored from original
    expect(
      ((merged.gateway as Record<string, unknown>).auth as Record<string, unknown>).token
    ).toBe('super-secret-gateway-token');

    // Telegram: user set new value, kept as-is
    expect((merged.channels as Record<string, unknown>).telegram).toMatchObject({
      botToken: 'brand-new-telegram-token',
    });

    // Discord: user removed it, stays removed
    expect((merged.channels as Record<string, unknown>).discord).toBeUndefined();

    // Slack: both restored from original
    expect((merged.channels as Record<string, unknown>).slack).toMatchObject({
      botToken: 'slack-bot-secret',
      appToken: 'slack-app-secret',
    });
  });
});

describe('array handling', () => {
  const CONFIG_WITH_ARRAYS = {
    models: {
      providers: [
        { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret-1' },
        { name: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-secret-2' },
      ],
    },
  };

  it('redacts secrets inside array entries', () => {
    const redacted = redactOpenclawConfig(CONFIG_WITH_ARRAYS);
    const providers = (redacted.models as Record<string, unknown>).providers as Array<
      Record<string, unknown>
    >;

    expect(providers[0].apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(providers[0].baseUrl).toBe('https://api.openai.com/v1');
    expect(providers[1].apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(providers[1].name).toBe('anthropic');
  });

  it('strips placeholders in array entries on restore (no index-based matching)', () => {
    const redacted = redactOpenclawConfig(CONFIG_WITH_ARRAYS);
    const merged = restoreRedactedSecrets(redacted, CONFIG_WITH_ARRAYS);

    // Array secrets are NOT restored — placeholders are stripped to avoid
    // position-dependent mismatches when users reorder entries.
    const providers = (merged.models as Record<string, unknown>).providers as Array<
      Record<string, unknown>
    >;
    expect(providers[0].apiKey).toBeUndefined();
    expect(providers[0].name).toBe('openai');
    expect(providers[1].apiKey).toBeUndefined();
    expect(providers[1].name).toBe('anthropic');
  });

  it('keeps new values in array entries when user set a non-placeholder value', () => {
    const redacted = redactOpenclawConfig(CONFIG_WITH_ARRAYS);
    const providers = (redacted.models as Record<string, unknown>).providers as Array<
      Record<string, unknown>
    >;
    providers[0].apiKey = 'sk-new-key';

    const merged = restoreRedactedSecrets(redacted, CONFIG_WITH_ARRAYS);
    const mergedProviders = (merged.models as Record<string, unknown>).providers as Array<
      Record<string, unknown>
    >;
    expect(mergedProviders[0].apiKey).toBe('sk-new-key');
    // Placeholder in second entry is stripped
    expect(mergedProviders[1].apiKey).toBeUndefined();
  });

  it('strips placeholders in array entries even when currentConfig has data', () => {
    const userConfig = {
      models: {
        providers: [
          { name: 'new-provider', apiKey: REDACTED_PLACEHOLDER, baseUrl: 'https://example.com' },
        ],
      },
    };
    const currentConfig = { models: { providers: [] } };

    const merged = restoreRedactedSecrets(userConfig, currentConfig);
    const providers = (merged.models as Record<string, unknown>).providers as Array<
      Record<string, unknown>
    >;
    expect(providers[0].apiKey).toBeUndefined();
    expect(providers[0].baseUrl).toBe('https://example.com');
  });

  it('redacts secrets in nested arrays', () => {
    const config = {
      groups: [{ members: [{ apiKey: 'nested-secret', name: 'bot' }] }],
    };
    const redacted = redactOpenclawConfig(config);
    const groups = redacted.groups as Array<Record<string, unknown>>;
    const members = groups[0].members as Array<Record<string, unknown>>;

    expect(members[0].apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(members[0].name).toBe('bot');
  });

  it('handles mixed array contents (strings, numbers, objects, nulls)', () => {
    const config = {
      items: ['hello', 42, { apiKey: 'secret-in-mixed', safe: true }, null],
    };
    const redacted = redactOpenclawConfig(config);
    const items = redacted.items as unknown[];

    expect(items[0]).toBe('hello');
    expect(items[1]).toBe(42);
    expect((items[2] as Record<string, unknown>).apiKey).toBe(REDACTED_PLACEHOLDER);
    expect((items[2] as Record<string, unknown>).safe).toBe(true);
    expect(items[3]).toBeNull();
  });

  it('handles empty arrays without error', () => {
    const config = { providers: [] };
    const redacted = redactOpenclawConfig(config);
    expect(redacted.providers).toEqual([]);

    const restored = restoreRedactedSecrets(redacted, config);
    expect(restored.providers).toEqual([]);
  });

  it('strips placeholders in deeply nested objects inside array elements', () => {
    const config = {
      list: [{ inner: { deep: { apiKey: 'deep-array-secret' } } }],
    };
    const redacted = redactOpenclawConfig(config);
    const list = redacted.list as Array<Record<string, unknown>>;
    const deep = (list[0].inner as Record<string, unknown>).deep as Record<string, unknown>;
    expect(deep.apiKey).toBe(REDACTED_PLACEHOLDER);

    const restored = restoreRedactedSecrets(redacted, config);
    const restoredList = restored.list as Array<Record<string, unknown>>;
    const restoredDeep = (restoredList[0].inner as Record<string, unknown>).deep as Record<
      string,
      unknown
    >;
    expect(restoredDeep.apiKey).toBeUndefined();
  });

  it('strips all placeholders regardless of array length mismatch', () => {
    const userConfig = {
      providers: [
        { apiKey: REDACTED_PLACEHOLDER, name: 'existing' },
        { apiKey: REDACTED_PLACEHOLDER, name: 'new-extra' },
      ],
    };
    const currentConfig = {
      providers: [{ apiKey: 'real-key', name: 'existing' }],
    };

    const merged = restoreRedactedSecrets(userConfig, currentConfig);
    const providers = merged.providers as Array<Record<string, unknown>>;
    expect(providers[0].apiKey).toBeUndefined();
    expect(providers[1].apiKey).toBeUndefined();
    expect(providers[1].name).toBe('new-extra');
  });

  it('strips placeholders when currentConfig has no array at that key', () => {
    const userConfig = {
      providers: [{ apiKey: REDACTED_PLACEHOLDER, name: 'orphan' }],
    };
    const currentConfig = {};

    const merged = restoreRedactedSecrets(userConfig, currentConfig);
    const providers = merged.providers as Array<Record<string, unknown>>;
    expect(providers[0].apiKey).toBeUndefined();
    expect(providers[0].name).toBe('orphan');
  });

  it('leaves arrays of primitives untouched', () => {
    const config = { tags: ['a', 'b', 'c'], counts: [1, 2, 3] };
    const redacted = redactOpenclawConfig(config);
    expect(redacted).toEqual(config);

    const restored = restoreRedactedSecrets(redacted, config);
    expect(restored).toEqual(config);
  });

  it('does not mutate original config when arrays are involved', () => {
    const original = JSON.parse(JSON.stringify(CONFIG_WITH_ARRAYS));
    redactOpenclawConfig(CONFIG_WITH_ARRAYS);
    expect(CONFIG_WITH_ARRAYS).toEqual(original);

    const redacted = redactOpenclawConfig(CONFIG_WITH_ARRAYS);
    const redactedCopy = JSON.parse(JSON.stringify(redacted));
    restoreRedactedSecrets(redacted, CONFIG_WITH_ARRAYS);
    expect(redacted).toEqual(redactedCopy);
  });
});

describe('isSecretKey', () => {
  it.each([
    'apiKey',
    'token',
    'botToken',
    'appToken',
    'secret',
    'password',
    'apiSecret',
    'accessToken',
    'refreshToken',
    'privateKey',
    'credential',
  ])('matches %s', key => expect(isSecretKey(key)).toBe(true));

  it.each(['baseUrl', 'port', 'enabled', 'name', 'mode', 'api', 'models', 'bind'])(
    'does not match %s',
    key => expect(isSecretKey(key)).toBe(false)
  );
});
