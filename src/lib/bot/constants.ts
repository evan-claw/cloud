import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/providers/anthropic';
import { minimax_m25_free_model } from '@/lib/providers/minimax';

export const BOT_VERSION = '5.1.0';
export const BOT_USER_AGENT = `Kilo-Code/${BOT_VERSION}`;
export const DEFAULT_BOT_MODEL = minimax_m25_free_model.is_enabled
  ? minimax_m25_free_model.public_id
  : CLAUDE_OPUS_CURRENT_MODEL_ID;
export const MAX_ITERATIONS = 5;
