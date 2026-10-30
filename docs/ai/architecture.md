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
    │       ├── 0001_add_status_to_orders.ts
    │       ├── 0002_create_jobs_table.ts
    │       ├── 0003_drop_status_from_orders.ts
    │       └── snapshot.json
    ├── queue/
    │   ├── queue.module.ts
    │   ├── queue.service.ts         # conexão, descoberta, workers, retry/DLQ, publish confirmado
    │   ├── job-store.service.ts     # tabela jobs: enqueue (outbox), claim, complete, release, fail
    │   ├── job-publisher.service.ts # varre jobs pending e publica na fila (outbox)
    │   ├── queue.config.ts          # concorrência por fila, lease, intervalos
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
├── QueueModule    (@Global)  -> QueueService (conecta, descobre jobs, consome), JobStore (tabela jobs),
│                                JobPublisher (publica os jobs pending)
└── OrdersModule              -> OrdersController, OrdersService, ProcessOrderJob
```

## Fluxo de `POST /orders`

1. `OrdersController.create` recebe `@Body() CreateOrderDto`; o `ZodValidationPipe` global valida (400 se inválido).
2. Delegação para `OrdersService.create(input)`.
3. O service abre uma transação (`db.transaction`): insere em `orders` via Drizzle (`amount.toFixed(2)`), obtém `insertId` e chama `jobStore.enqueue(tx, ProcessOrderJob, payload)`, que grava o job `pending` na tabela `jobs` (outbox). Pedido e job são confirmados ou desfeitos juntos.
4. O controller retorna o objeto com status 201 (mesmo com o RabbitMQ fora do ar); o `ZodSerializerInterceptor` valida a saída com `orderResponseSchema`.
5. Em segundo plano, o `JobPublisher` lê os jobs `pending` (`FOR UPDATE SKIP LOCKED`), publica na fila `order_processing` (`type: process_order`, `messageId` = id do job) com confirmação do broker e os marca `published` (📤).
6. O worker consome: 📥 Recebido -> reivindica o job (`claim`) -> ⚙️ Processando -> ✅ Concluído, e marca `done`. Duplicatas são ignoradas (`⏭️`); em falha, retry atrasado (`🔁`) até `retries` e depois DLQ `order_processing.dlq` (`💀`), com o job `failed`.

## Ciclo de vida da aplicação

1. `main.ts`: `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` -> `app.enableShutdownHooks()` -> `app.listen(env.PORT, "0.0.0.0")`.
2. `QueueService.onModuleInit` (antes do `listen`): descobre providers com `@Job`, conecta ao RabbitMQ, declara filas, filas de retry e DLQs (`durable: true`), inicia um consumidor por fila (`prefetch` = concorrência da fila, padrão 1).
3. `JobPublisher.onApplicationBootstrap` (depois de todos os `onModuleInit`): inicia a varredura da tabela `jobs`.
4. `JobPublisher.beforeApplicationShutdown`: para a varredura e espera a rodada em andamento, antes de a fila fechar.
5. `QueueService.onApplicationShutdown`: fecha canais e conexão.
6. `DatabaseModule` fecha o pool `mysql2` em `onApplicationShutdown`.

## Regras de dependência entre camadas

- `controller` -> `service` -> (`DRIZZLE`, `JobStore`). Nunca o inverso. Serviços de domínio gravam jobs com `JobStore.enqueue` dentro da transação; só o `JobPublisher` publica na fila.
- Jobs podem injetar services (via DI) e despachar outros jobs.
- Módulos de domínio não importam uns aos outros por caminho de arquivo; exporte o provider no `exports` do módulo e importe o módulo.
- Infra (`database`, `queue`) não conhece módulos de domínio.
