import { describe, expect, it } from 'vitest';

import { validateEnvironment } from '../src/config/environment';

const productionBase = {
  APP_ENV: 'production',
  STORAGE_BACKEND: 's3',
  JWT_SECRET_KEY: 'a-production-secret-with-32-characters',
};

describe('production environment validation', () => {
  it('fails fast when DashScope credentials are missing', () => {
    expect(() => validateEnvironment({ ...productionBase, AI_PROVIDER: 'dashscope' })).toThrow('DASHSCOPE_API_KEY');
  });

  it('does not allow the deterministic local provider', () => {
    expect(() => validateEnvironment({ ...productionBase, AI_PROVIDER: 'local' })).toThrow('AI_PROVIDER');
  });

  it('accepts a configured OpenAI-compatible provider', () => {
    expect(
      validateEnvironment({
        ...productionBase,
        AI_PROVIDER: 'openai_compatible',
        OPENAI_COMPATIBLE_BASE_URL: 'https://llm.example.com/v1',
        OPENAI_COMPATIBLE_API_KEY: 'secret',
        OPENAI_COMPATIBLE_CHAT_MODEL: 'chat-model',
        OPENAI_COMPATIBLE_EMBEDDING_MODEL: 'embedding-model',
      }).AI_PROVIDER,
    ).toBe('openai_compatible');
  });
});
