import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@ApiTags('Metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Get()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async getMetrics(@Res() res: Response) {
    res.set('Content-Type', this.metrics.getContentType());
    res.send(await this.metrics.getMetrics());
  }
}
