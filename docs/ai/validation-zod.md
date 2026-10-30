# Validação com Zod + nestjs-zod

Entrada e saída de **toda** rota são validadas por Zod. Nunca valide manualmente no handler.

## Schema por recurso — `src/orders/order.schema.ts`

```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Schema Zod do payload aceito em `POST /orders`.
 */
export const createOrderSchema = z.object({
  customer_email: z.email(),
  product: z.string().min(1).max(255),
  amount: z.number().positive().multipleOf(0.01),
});

/**
 * Schema Zod da resposta de `POST /orders`.
 */
export const orderResponseSchema = z.object({
  id: z.number().int().positive(),
  customer_email: z.email(),
  product: z.string(),
  amount: z.number(),
});

/**
 * DTO do corpo de criação de pedido, derivado de `createOrderSchema`.
 */
export class CreateOrderDto extends createZodDto(createOrderSchema) {}

/**
 * DTO da resposta de um pedido, derivado de `orderResponseSchema`.
 */
export class OrderResponseDto extends createZodDto(orderResponseSchema) {}
```

Para `params` e `query`, crie `orderParamsSchema`/`listOrdersQuerySchema` (use `z.coerce.number()` para valores vindos de string) e os DTOs correspondentes.

## Registro global — `src/app.module.ts`

```ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
    DatabaseModule,
    QueueModule,
    HealthModule,
    OrdersModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
```

## Regras

- Entrada: `@Body() dto: CreateOrderDto` (idem `@Param`, `@Query`) -> `ZodValidationPipe` responde 400 com os issues do Zod.
- Saída: `@ZodSerializerDto(OrderResponseDto)` no handler -> `ZodSerializerInterceptor` valida e remove campos extras.
- Tipos: use o próprio DTO como tipo (`CreateOrderDto`), ou `z.infer<typeof schema>` quando precisar do tipo puro.
- Mensagens e nomes de campos do payload permanecem em `snake_case` (`customer_email`); o código interno usa `camelCase`.
- Variáveis de ambiente **não** são validadas (ver `src/config/env.ts`; o `ConfigModule` só repassa o objeto `env`, sem `validate`).
- Proibido `class-validator`/`class-transformer`/`ValidationPipe` nativo.
