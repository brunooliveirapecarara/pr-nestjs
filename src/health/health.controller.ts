import { Controller, Get } from '@nestjs/common';

/**
 * Endpoint de healthcheck da aplicação.
 */
@Controller('health')
export class HealthController {
  /**
   * Healthcheck simples da aplicação.
   *
   * @returns Objeto indicando que o serviço está no ar.
   */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
