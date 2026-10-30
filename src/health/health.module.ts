import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * Módulo do healthcheck da aplicação.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
