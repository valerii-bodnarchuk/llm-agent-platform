import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      throw new Error('REDIS_URL is not defined');
    }

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }

  getClient(): Redis {
    return this.client;
  }

  getConnectionConfig() {
    return {
      url: process.env.REDIS_URL,
    };
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}