// Port of src/lib/custom-llm/format.ts

export enum ReasoningFormat {
  Unknown = 'unknown',
  OpenAIResponsesV1 = 'openai-responses-v1',
  XAIResponsesV1 = 'xai-responses-v1',
  AnthropicClaudeV1 = 'anthropic-claude-v1',
  GoogleGeminiV1 = 'google-gemini-v1',
  // Prevents the extension from stripping ids
  OpenAIResponsesV1_Obscured = 'openai-responses-v1-obscured',
}

export const DEFAULT_REASONING_FORMAT = ReasoningFormat.AnthropicClaudeV1;
