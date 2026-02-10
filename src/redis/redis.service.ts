import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly connectionConfig: { host: string; port: number };

  constructor() {
    this.connectionConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    };

    this.client = new Redis({
      ...this.connectionConfig,
      maxRetriesPerRequest: null, // required by BullMQ when sharing connection
    });
  }

  /** Direct Redis client for get/set/exists operations */
  getClient(): Redis {
    return this.client;
  }

  /** Connection config for BullMQ Queue/Worker (they create own connections) */
  getConnectionConfig(): { host: string; port: number } {
    return this.connectionConfig;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
