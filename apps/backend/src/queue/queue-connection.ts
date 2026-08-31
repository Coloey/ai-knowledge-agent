import type { RedisOptions } from 'ioredis';

export function redisOptionsFromUrl(connectionUrl: string): RedisOptions {
  const url = new URL(connectionUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number.isInteger(database) ? database : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    enableReadyCheck: true,
  };
}
