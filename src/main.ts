import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

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
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`🚀 Servidor escutando na porta ${env.PORT}`);
}

await bootstrap();
