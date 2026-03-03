// Port of src/lib/custom-llm/reasoning-details.ts
// Minimal type definitions needed by customLlmRequest.

import type { ReasoningFormat } from './format';

export enum ReasoningDetailType {
  Summary = 'reasoning.summary',
  Encrypted = 'reasoning.encrypted',
  Text = 'reasoning.text',
}

export type ReasoningDetailSummary = {
  type: ReasoningDetailType.Summary;
  summary: string;
  id?: string | null;
  format?: ReasoningFormat | null;
  index?: number;
};

export type ReasoningDetailEncrypted = {
  type: ReasoningDetailType.Encrypted;
  data: string;
  id?: string | null;
  format?: ReasoningFormat | null;
  index?: number;
};

export type ReasoningDetailText = {
  type: ReasoningDetailType.Text;
  text?: string | null;
  signature?: string | null;
  id?: string | null;
  format?: ReasoningFormat | null;
  index?: number;
};

export type ReasoningDetailUnion =
  | ReasoningDetailSummary
  | ReasoningDetailEncrypted
  | ReasoningDetailText;
