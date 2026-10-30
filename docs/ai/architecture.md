# Arquitetura

Monólito modular NestJS. Cada módulo de domínio é autocontido; infraestrutura (banco e fila) é exposta por módulos `@Global()`.

## Árvore de pastas

```
poc-nestjs/
├── AGENTS.md / CLAUDE.md
├── docs/ai/*.md
├── .github/copilot-instructions.md
├── Dockerfile / docker-compose.yml / .env.example
├── package.json / tsconfig.json / drizzle.config.ts
└── src/
    ├── main.ts                      # único ponto de entrada
    ├── app.module.ts                # módulo raiz + providers globais (pipe/interceptor)
    ├── health.controller.ts         # GET /health
    ├── config/
    │   └── env.ts
    ├── database/
    │   ├── database.constants.ts    # export const DRIZZLE = Symbol("DRIZZLE")
    │   ├── database.module.ts
    │   ├── schema.ts
    │   ├── migration-files.ts
    │   ├── migration-generate.ts
    │   ├── migrate-up.ts / migrate-down.ts / migrate-fresh.ts
    │   └── migrations/
    │       ├── 0000_create_orders_table.ts
    │       └── snapshot.json
    ├── queue/
    │   ├── queue.module.ts
    │   ├── queue.service.ts
    │   └── job.decorator.ts
    ├── jobs/
    │   └── process-order.job.ts
    └── orders/
        ├── orders.module.ts
        ├── orders.controller.ts
        ├── orders.service.ts
        └── order.schema.ts
```

## Grafo de módulos

```
AppModule
├── DatabaseModule (@Global)  -> provider DRIZZLE
├── QueueModule    (@Global)  -> QueueService (conecta, descobre jobs, consome)
└── OrdersModule              -> OrdersController, OrdersService, ProcessOrderJob
```

## Fluxo de `POST /orders`

1. `OrdersController.create` recebe `@Body() CreateOrderDto`; o `ZodValidationPipe` global valida (400 se inválido).
2. Delegação para `OrdersService.create(input)`.
3. O service insere em `orders` via Drizzle (`amount.toFixed(2)`), obtém `insertId`.
4. O service chama `queueService.dispatch(ProcessOrderJob, payload)` (fila `order_processing`, `type: process_order`).
5. O controller retorna o objeto com status 201; o `ZodSerializerInterceptor` valida a saída com `orderResponseSchema`.
6. O worker consome: 📥 Recebido -> ⚙️ Processando -> ✅ Concluído; `ack` em sucesso; em falha, retry atrasado (`🔁`) até `retries` e depois DLQ `order_processing.dlq` (`💀`).

## Ciclo de vida da aplicação

1. `main.ts`: `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` -> `app.enableShutdownHooks()` -> `app.listen(env.PORT, "0.0.0.0")`.
2. `QueueService.onModuleInit` (antes do `listen`): descobre providers com `@Job`, conecta ao RabbitMQ, declara filas, filas de retry e DLQs (`durable: true`), inicia um consumidor por fila (`prefetch` = concorrência da fila, padrão 1).
3. `QueueService.onApplicationShutdown`: fecha canais e conexão.
4. `DatabaseModule` fecha o pool `mysql2` em `onApplicationShutdown`.

## Regras de dependência entre camadas

- `controller` -> `service` -> (`DRIZZLE`, `QueueService`). Nunca o inverso.
- Jobs podem injetar services (via DI) e despachar outros jobs.
- Módulos de domínio não importam uns aos outros por caminho de arquivo; exporte o provider no `exports` do módulo e importe o módulo.
- Infra (`database`, `queue`) não conhece módulos de domínio.
