# Sintaxe NestJS — exemplos canônicos

Todo código gerado deve seguir estes moldes (incluindo Docblocks completos, conforme `AGENTS.md`). Projeto ESM (`nodenext`), Prettier com aspas simples e vírgula final: imports relativos levam a extensão `.js` (ex.: `from "./app.module.js"`).

## main.ts

```ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

/**
 * Inicializa a aplicação Nest e começa a escutar requisições HTTP.
 *
 * @returns Promise resolvida quando o servidor estiver escutando.
 * @throws Erro de bootstrap (ex.: RabbitMQ indisponível no `onModuleInit` da fila).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`🚀 Servidor escutando na porta ${env.PORT}`);
}

await bootstrap();
```

## Module

```ts
import { Module } from '@nestjs/common';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/**
 * Módulo de domínio de pedidos.
 */
@Module({
  controllers: [OrdersController],
  providers: [OrdersService, ProcessOrderJob],
  exports: [OrdersService],
})
export class OrdersModule {}
```

Módulo global de infraestrutura: `@Global() @Module({ providers: [...], exports: [...] })`.

## Controller (fino)

```ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { CreateOrderDto, OrderResponseDto } from './order.schema.js';
import { OrdersService } from './orders.service.js';

/**
 * Endpoints HTTP de pedidos.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * Cria um pedido, persiste e o enfileira para processamento.
   *
   * @param body - Corpo `{ customer_email, product, amount }` já validado pelo pipe global.
   * @returns O pedido criado, com status 201.
   * @throws Erro do driver se a gravação no banco falhar.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(OrderResponseDto)
  create(@Body() body: CreateOrderDto): Promise<OrderResponseDto> {
    return this.ordersService.create(body);
  }
}
```

Parâmetros e query: `@Get(":id") find(@Param() params: OrderParamsDto, @Query() query: ListOrdersQueryDto)`, sempre com DTOs `createZodDto`.

## Service com Drizzle

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { DRIZZLE } from '../database/database.constants.js';
import * as schema from '../database/schema.js';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { JobStore } from '../queue/job-store.service.js';
import type { CreateOrderDto, OrderResponseDto } from './order.schema.js';

/**
 * Regras de negócio de pedidos.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>,
    private readonly jobs: JobStore,
  ) {}

  /**
   * Persiste o pedido e grava o job `process_order` na mesma transação (outbox).
   *
   * @param input - Dados validados do pedido.
   * @returns Pedido criado com o `id` gerado.
   * @throws Erro do driver se algum insert falhar (a transação é desfeita).
   */
  async create(input: CreateOrderDto): Promise<OrderResponseDto> {
    const orderId = await this.db.transaction(async (tx) => {
      const [result] = await tx.insert(schema.orders).values({
        customerEmail: input.customer_email,
        product: input.product,
        amount: input.amount.toFixed(2),
      });

      await this.jobs.enqueue(tx, ProcessOrderJob, {
        orderId: result.insertId,
        customerEmail: input.customer_email,
        product: input.product,
        amount: input.amount,
      });

      return result.insertId;
    });

    return {
      id: orderId,
      customer_email: input.customer_email,
      product: input.product,
      amount: input.amount,
    };
  }
}
```

Note: `import type` é permitido para `MySql2Database` e DTOs usados só como tipo em parâmetros **não injetados**; `JobStore` é injetado e portanto usa import normal.

## Provider customizado (token)

```ts
export const DRIZZLE = Symbol('DRIZZLE');

{
  provide: DRIZZLE,
  useFactory: (): MySql2Database<typeof schema> => drizzle(pool, { schema, mode: 'default' }),
}
```

## Ciclo de vida

Implemente `OnModuleInit`, `OnApplicationShutdown` etc. de `@nestjs/common`; documente cada hook com Docblock.

## Exceções e HTTP

Use as exceções do Nest (`NotFoundException`, `BadRequestException`) no service. Erros de validação Zod já viram 400 pelo `ZodValidationPipe`. Falhas de serialização de saída viram 500 (`ZodSerializationException`).

## Health

```ts
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
```

## Testes

`yarn test` (Vitest) com `@nestjs/testing`: `Test.createTestingModule({ imports: [...] }).overrideProvider(DRIZZLE).useValue(fake).compile()`. Arquivos `*.spec.ts` ao lado do código.

## Proibido

- `class-validator`, `class-transformer`, `@nestjs/config`, `@nestjs/microservices`, `@nestjs/typeorm`.
- Injeção por propriedade, `new` manual de providers, `console.log`, `any`.
- Regra de negócio ou acesso a banco dentro de controllers.
