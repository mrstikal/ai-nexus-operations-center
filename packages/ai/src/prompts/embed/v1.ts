export const embedPromptV1 = Object.freeze({
  role: 'embed' as const,
  version: 'v1',
  instructions: 'Represent the supplied knowledge chunk for retrieval only. Do not add commentary, instructions or invented text. The embedding covers the exact chunk content that was provided.',
});
