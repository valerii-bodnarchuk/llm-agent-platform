import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class IdempotencyService {
  constructor(private redisService: RedisService) {}

  async get(key: string): Promise<string | null> {
    return this.redisService.getClient().get(key);
  }

  async set(key: string, value: string, ttlSeconds: number = 86400): Promise<void> {
    await this.redisService.getClient().setex(key, ttlSeconds, value);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redisService.getClient().exists(key)) === 1;
  }
}
