import { describe, it, expect } from '@jest/globals';
import {
  validateMagicLinkSignupEmail,
  magicLinkSignupEmailSchema,
  MAGIC_LINK_EMAIL_ERRORS,
  hasBlockedTLD,
  BLOCKED_SIGNUP_TLDS,
} from './email';

describe('validateMagicLinkSignupEmail', () => {
  it('should accept valid lowercase email without +', () => {
    const result = validateMagicLinkSignupEmail('user@example.com');
    expect(result).toEqual({ valid: true, error: null });
  });

  it('should reject email with uppercase characters', () => {
    const result = validateMagicLinkSignupEmail('User@Example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject email with + character for non-kilocode domains', () => {
    const result = validateMagicLinkSignupEmail('user+tag@example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
  });

  it('should allow email with + character for @kilocode.ai domain', () => {
    const result = validateMagicLinkSignupEmail('user+tag@kilocode.ai');
    expect(result).toEqual({ valid: true, error: null });
  });

  it('should reject email with + character for lookalike domains ending in kilocode.ai', () => {
    // @henkkilocode.ai ends with "kilocode.ai" but is not the @kilocode.ai domain
    const result = validateMagicLinkSignupEmail('mark+klaas@henkkilocode.ai');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
  });

  it('should reject email with both uppercase and +', () => {
    // Uppercase check happens first
    const result = validateMagicLinkSignupEmail('User+tag@Example.com');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject uppercase @kilocode.ai email even with +', () => {
    // Uppercase check happens first, even for kilocode.ai
    const result = validateMagicLinkSignupEmail('User+tag@kilocode.ai');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
  });

  it('should reject email with blocked TLD .shop', () => {
    const result = validateMagicLinkSignupEmail('user@example.shop');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.BLOCKED_TLD });
  });

  it('should reject email with blocked TLD .top', () => {
    const result = validateMagicLinkSignupEmail('user@example.top');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.BLOCKED_TLD });
  });

  it('should reject email with blocked TLD .xyz', () => {
    const result = validateMagicLinkSignupEmail('user@example.xyz');
    expect(result).toEqual({ valid: false, error: MAGIC_LINK_EMAIL_ERRORS.BLOCKED_TLD });
  });

  it('should not reject email with allowed TLD', () => {
    const result = validateMagicLinkSignupEmail('user@example.com');
    expect(result).toEqual({ valid: true, error: null });
  });
});

describe('magicLinkSignupEmailSchema', () => {
  it('should accept valid lowercase email without +', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user@example.com');
    expect(result.success).toBe(true);
  });

  it('should reject invalid email format', () => {
    const result = magicLinkSignupEmailSchema.safeParse('not-an-email');
    expect(result.success).toBe(false);
  });

  it('should reject email with uppercase characters', () => {
    const result = magicLinkSignupEmailSchema.safeParse('User@Example.com');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Email address must be lowercase');
    }
  });

  it('should reject email with + character for non-kilocode domains', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user+tag@example.com');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Email address cannot contain a + character');
    }
  });

  it('should allow email with + character for @kilocode.ai domain', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user+tag@kilocode.ai');
    expect(result.success).toBe(true);
  });

  it('should reject email with + character for lookalike domains ending in kilocode.ai', () => {
    // @henkkilocode.ai ends with "kilocode.ai" but is not the @kilocode.ai domain
    const result = magicLinkSignupEmailSchema.safeParse('mark+klaas@henkkilocode.ai');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Email address cannot contain a + character');
    }
  });

  it('should reject email with blocked TLD .shop', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user@example.shop');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Signups from this email domain are not currently supported.'
      );
    }
  });

  it('should reject email with blocked TLD .top', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user@example.top');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Signups from this email domain are not currently supported.'
      );
    }
  });

  it('should reject email with blocked TLD .xyz', () => {
    const result = magicLinkSignupEmailSchema.safeParse('user@example.xyz');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Signups from this email domain are not currently supported.'
      );
    }
  });
});

describe('hasBlockedTLD', () => {
  it('should block .shop TLD', () => {
    expect(hasBlockedTLD('user@example.shop')).toBe(true);
  });

  it('should block .top TLD', () => {
    expect(hasBlockedTLD('user@example.top')).toBe(true);
  });

  it('should block .xyz TLD', () => {
    expect(hasBlockedTLD('user@example.xyz')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(hasBlockedTLD('user@example.SHOP')).toBe(true);
    expect(hasBlockedTLD('user@example.Top')).toBe(true);
    expect(hasBlockedTLD('user@example.XYZ')).toBe(true);
  });

  it('should not block .com TLD', () => {
    expect(hasBlockedTLD('user@example.com')).toBe(false);
  });

  it('should not block .org TLD', () => {
    expect(hasBlockedTLD('user@example.org')).toBe(false);
  });

  it('should not block domains that merely contain a blocked TLD as a substring', () => {
    // "workshop.com" contains "shop" but is not a .shop TLD
    expect(hasBlockedTLD('user@workshop.com')).toBe(false);
    // "laptop.com" contains "top" but is not a .top TLD
    expect(hasBlockedTLD('user@laptop.com')).toBe(false);
  });

  it('should block subdomains of blocked TLDs', () => {
    expect(hasBlockedTLD('user@mail.example.shop')).toBe(true);
    expect(hasBlockedTLD('user@subdomain.example.top')).toBe(true);
  });

  it('should contain the expected TLDs', () => {
    expect(BLOCKED_SIGNUP_TLDS).toEqual(['.shop', '.top', '.xyz']);
  });
});
