import { z } from 'zod';

const booleanString = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}, z.boolean());

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    APP_NAME: z.string().default('AI Knowledge Agent'),
    PORT: z.coerce.number().int().positive().default(8000),
    CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173,http://localhost:8080'),
    DATABASE_URL: z.string().min(1).default('postgresql://agent:agent@localhost:5432/agent'),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
    QUEUE_REDIS_URL: z.string().min(1).default('redis://localhost:6379/0'),
    CONTROL_REDIS_URL: z.string().min(1).default('redis://localhost:6379/1'),
    QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
    STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_DIR: z.string().default('./storage'),
    S3_ENDPOINT_URL: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('agent-files'),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanString.default(true),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    TIKA_URL: z.string().url().default('http://localhost:9998'),
    TIKA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    AI_PROVIDER: z.enum(['dashscope', 'openai_compatible', 'local']).default('dashscope'),
    DASHSCOPE_API_KEY: z.string().optional(),
    DASHSCOPE_BASE_URL: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    DASHSCOPE_EMBEDDING_MODEL: z.string().default('text-embedding-v2'),
    DASHSCOPE_CHAT_MODEL: z.string().default('qwen-plus'),
    OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
    OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
    OPENAI_COMPATIBLE_EMBEDDING_MODEL: z.string().optional(),
    OPENAI_COMPATIBLE_CHAT_MODEL: z.string().optional(),
    EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1536),
    SSE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
    JWT_SECRET_KEY: z.string().min(16).default('local-only-change-me'),
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: z.coerce.number().int().positive().default(30),
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: z.coerce.number().int().positive().default(14),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((value, context) => {
    if (value.EMBEDDING_DIMENSION !== 1536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMBEDDING_DIMENSION'],
        message: 'EMBEDDING_DIMENSION must match the current vector(1536) database schema',
      });
    }
    if (value.APP_ENV === 'production' && value.JWT_SECRET_KEY.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET_KEY'],
        message: 'JWT_SECRET_KEY must be at least 32 characters in production',
      });
    }
    if (value.APP_ENV === 'production' && value.STORAGE_BACKEND === 'local') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_BACKEND'],
        message: 'Production storage must use s3-compatible object storage',
      });
    }
    if (value.APP_ENV === 'production' && value.AI_PROVIDER === 'local') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_PROVIDER'],
        message: 'The deterministic local AI provider is not allowed in production',
      });
    }
    if (value.APP_ENV === 'production' && value.AI_PROVIDER === 'dashscope' && !value.DASHSCOPE_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DASHSCOPE_API_KEY'],
        message: 'DASHSCOPE_API_KEY is required for the production DashScope provider',
      });
    }
    if (value.APP_ENV === 'production' && value.AI_PROVIDER === 'openai_compatible') {
      for (const key of [
        'OPENAI_COMPATIBLE_BASE_URL',
        'OPENAI_COMPATIBLE_API_KEY',
        'OPENAI_COMPATIBLE_CHAT_MODEL',
        'OPENAI_COMPATIBLE_EMBEDDING_MODEL',
      ] as const) {
        if (!value[key]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required for the production OpenAI-compatible provider`,
          });
        }
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  return environmentSchema.parse(input);
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
