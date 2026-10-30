import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

/**
 * Inicializa a aplicação Nest e começa a escutar requisições HTTP.
 *
 * @returns Promise resolvida quando o servidor estiver escutando.
 * @throws Erro de bootstrap (ex.: RabbitMQ indisponível no `onModuleInit` da fila).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  const port = app.get<ConfigService<Env, true>>(ConfigService).get('PORT', {
    infer: true,
  });
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`🚀 Servidor escutando na porta ${port}`);
}

await bootstrap();
