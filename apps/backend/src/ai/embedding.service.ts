import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import type { Environment } from '../config/environment';

@Injectable()
export class EmbeddingService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<Environment, true>) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const provider = this.config.get('AI_PROVIDER', { infer: true });
    if (provider === 'local') return texts.map((text) => this.deterministicEmbedding(text));

    const isDashScope = provider === 'dashscope';
    const apiKey = isDashScope
      ? this.config.get('DASHSCOPE_API_KEY', { infer: true })
      : this.config.get('OPENAI_COMPATIBLE_API_KEY', { infer: true });
    const baseURL = isDashScope
      ? this.config.get('DASHSCOPE_BASE_URL', { infer: true })
      : this.config.get('OPENAI_COMPATIBLE_BASE_URL', { infer: true });
    const model = isDashScope
      ? this.config.get('DASHSCOPE_EMBEDDING_MODEL', { infer: true })
      : this.config.get('OPENAI_COMPATIBLE_EMBEDDING_MODEL', { infer: true });
    if (!apiKey || !baseURL || !model) {
      if (this.config.get('APP_ENV', { infer: true }) === 'production') {
        throw new Error(`Embedding provider ${provider} is not fully configured`);
      }
      return texts.map((text) => this.deterministicEmbedding(text));
    }

    const response = await new OpenAI({ apiKey, baseURL, timeout: 60_000, maxRetries: 2 }).embeddings.create({
      model,
      input: texts,
    });
    const embeddings = response.data.map((item) => item.embedding);
    const expectedDimension = this.config.get('EMBEDDING_DIMENSION', { infer: true });
    if (embeddings.some((embedding) => embedding.length !== expectedDimension)) {
      throw new Error(`Embedding dimension does not match configured dimension ${expectedDimension}`);
    }
    return embeddings;
  }

  private deterministicEmbedding(text: string): number[] {
    const dimension = this.config.get('EMBEDDING_DIMENSION', { infer: true });
    const seed = createHash('sha256').update(text).digest();
    const values = Array.from({ length: dimension }, (_, index) => seed[index % seed.length] / 255 - 0.5);
    const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0)) || 1;
    return values.map((value) => value / norm);
  }
}
