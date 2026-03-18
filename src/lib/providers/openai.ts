export function isOpenAiModel(requestedModel: string) {
  return requestedModel.startsWith('openai/') && !requestedModel.startsWith('openai/gpt-oss');
}

export function isOpenAiOssModel(requestedModel: string) {
  return requestedModel.startsWith('openai/gpt-oss');
}
