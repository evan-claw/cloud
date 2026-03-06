// Zod Schemas
export {
  SecretCategorySchema,
  SecretIconKeySchema,
  InjectionMethodSchema,
  SecretFieldDefinitionSchema,
  SecretCatalogEntrySchema,
} from './types.js';

// Types
export type {
  SecretCategory,
  SecretIconKey,
  InjectionMethod,
  SecretFieldDefinition,
  SecretCatalogEntry,
} from './types.js';

export { DEFAULT_INJECTION_METHOD, getInjectionMethod } from './types.js';

// Catalog and lookup helpers
export {
  SECRET_CATALOG,
  SECRET_CATALOG_MAP,
  ALL_SECRET_FIELD_KEYS,
  FIELD_KEY_TO_ENV_VAR,
  FIELD_KEY_TO_ENTRY,
  getEntriesByCategory,
} from './catalog.js';

// Validation
export { validateFieldValue } from './validation.js';
