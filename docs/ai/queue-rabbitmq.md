# Fila: RabbitMQ (amqplib) com NestJS

Wrapper próprio (sem `@nestjs/microservices`). Suporta várias filas, cada uma com vários jobs. A mensagem carrega o nome do job em `properties.type`.

## Decorator e contrato — `src/queue/job.decorator.ts`

```ts
import { DiscoveryService } from '@nestjs/core';

export const DEFAULT_JOB_RETRIES = 0;
export const DEFAULT_JOB_BACKOFF_MS = 5000;

/**
 * Metadados de um job: fila onde roda, seu nome e a política de retry.
 */
export interface JobOptions {
  queue: string;
  name: string;
  /** Quantas vezes reexecutar após uma falha, antes de enviar à DLQ. Padrão: 0. */
  retries?: number;
  /** Atraso em ms antes de cada nova tentativa. Padrão: 5000. */
  backoffMs?: number;
}

/**
 * Contrato implementado por toda classe de job.
 */
export interface JobHandler<TPayload> {
  /**
   * Executa o job a partir do payload recebido da fila.
   *
   * @param payload - Dados deserializados da mensagem.
   * @returns Promise resolvida quando o processamento terminar.
   */
  handle(payload: TPayload): Promise<void>;
}

/**
 * Marca uma classe `@Injectable()` como job de uma fila. Criado por `DiscoveryService.createDecorator`:
 * só assim `DiscoveryService.getProviders({ metadataKey: Job.KEY })` enxerga as classes decoradas.
 */
export const Job = DiscoveryService.createDecorator<JobOptions>();
```

## Um job — `src/jobs/process-order.job.ts`

```ts
import { setTimeout } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { Job, type JobHandler } from '../queue/job.decorator.js';

/**
 * Dados do pedido enviados ao job `process_order`.
 */
export interface OrderMessage {
  orderId: number;
  customerEmail: string;
  product: string;
  amount: number;
}

/**
 * Processa um pedido apenas registrando o ciclo de vida, sem efeitos externos reais. A idempotência é
 * garantida pelo `QueueService`, que reivindica o job na tabela `jobs` antes de chamar o `handle`.
 */
@Injectable()
@Job({ queue: 'order_processing', name: 'process_order', retries: 3, backoffMs: 5000 })
export class ProcessOrderJob implements JobHandler<OrderMessage> {
  private readonly logger = new Logger(ProcessOrderJob.name);

  /**
   * Processa um pedido registrando o ciclo de vida do job.
   *
   * @param order - Dados do pedido a processar.
   * @returns Promise resolvida quando o processamento terminar.
   */
  async handle(order: OrderMessage): Promise<void> {
    this.logger.log(`⚙️ Processando pedido #${order.orderId} de ${order.customerEmail}`);
    await setTimeout(500);
    this.logger.log(`✅ Concluído pedido #${order.orderId} (${order.product})`);
  }
}
```

O job só é registrado se a classe estiver em `providers` de algum módulo.

## Tabela `jobs`: outbox e idempotência

A tabela `jobs` (ver `database-drizzle.md`) resolve dois problemas de uma vez. O `id` de cada linha é o `messageId` da mensagem.

### Outbox (nenhum job se perde)

O `POST /orders` grava o pedido e **o job** na mesma transação (`JobStore.enqueue(tx, JobClass, payload)`), em vez de publicar direto. Se o RabbitMQ estiver fora do ar, o pedido responde 201 e o job espera como `pending`.

- `JobPublisher` (em `src/queue/job-publisher.service.ts`) varre a tabela a cada `JOB_PUBLISH_INTERVAL_MS`: lê os `pending` em uma transação com `FOR UPDATE SKIP LOCKED` (várias réplicas não pegam o mesmo job), publica com **confirmação do broker** (`QueueService.publish`, canal `ConfirmChannel`) e só então marca `published`.
- Se a publicação falhar, o lote para e os demais continuam `pending` para a próxima rodada.
- A varredura apaga periodicamente os `done` mais velhos que `JOB_RETENTION_MS`; `failed` nunca é apagado.
- Ciclo de vida do hook: `onApplicationBootstrap` (depois de a fila conectar) inicia; `beforeApplicationShutdown` para e espera a rodada em andamento.

### Idempotência (cada job roda uma vez)

A entrega é "pelo menos uma vez": a mesma mensagem pode chegar mais de uma vez (reentrega após queda do broker, falha entre o reenvio do retry e o `ack`, duas réplicas, `concorrência > 1`). O `QueueService` trata isso para **todo** job com `messageId`, sem código no job:

1. `JobStore.claim(id)` faz um `UPDATE ... SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND (status IN ('pending','published') OR (status = 'processing' AND started_at < agora - JOB_LEASE_MS))`. A atomicidade do banco garante um único dono, mesmo entre cópias simultâneas.
2. Resultado do `claim`:
   - `claimed`: executa o `handle`; ao terminar, `complete` marca `done`.
   - `finished` (`done`/`failed`) ou `missing`: duplicata; loga `⏭️` e dá `ack` sem executar.
   - `busy` (outro worker executa dentro do lease): `nack` com requeue depois de `REQUEUE_DELAY_MS`, até o outro terminar (aí vira `finished`) ou o lease expirar.
   - erro do banco: também `nack` com requeue atrasado; o job não consome tentativa de retry.
3. Falha do `handle` com tentativas restantes: `release` volta o job a `published` (guardando `last_error`) e a mensagem vai à fila de retry. Esgotadas as tentativas (ou job desconhecido/payload inválido): a mensagem vai à DLQ e `fail` marca `failed`.
4. O **lease** (`JOB_LEASE_MS`, 5 min) cobre o worker que morreu no meio: a próxima entrega reassume o job. Por isso um job longo não deve passar do lease.
5. Mensagens sem `messageId` (publicadas por `dispatch`, ou reinjetadas à mão) rodam sem registro: sem idempotência nem rastreio.

Garantias e limites:

- Isso garante **uma execução do `handle` por job no banco**, não por efeito externo: e-mail, pagamento etc. precisam de chave de idempotência no provedor (use o `id` do job), porque o `handle` pode ser reexecutado se o worker morrer depois do efeito e antes do `complete`.
- Reprocessar da DLQ: reinjetar a mensagem não basta (o job está `failed` e seria ignorado); volte a linha a `published` e reenvie.
- Uma falha do banco ao registrar a falha (`release`) devolve a mensagem à fila e ela espera o lease antes de ser reassumida.

## QueueService — `src/queue/queue.service.ts` (responsabilidades)

- `onModuleInit`: usa `DiscoveryService.getProviders({ metadataKey: Job.KEY })` + `getMetadataByDecorator(Job, wrapper)` para montar o registry `Map<queue, Map<name, { handler, retries, backoffMs }>>`; conecta com recuperação automática (`amqp.connect(env.RABBITMQ_URL, { recovery: { initialMaxRetries: 5, maxRetries: Infinity, waitForConnect: false, setup } })`) e aguarda `waitForConnect()`. O `setup` do amqplib roda a cada (re)conexão e monta o canal publicador, a topologia (abaixo) e os workers: os canais não são recriados sozinhos.
- `dispatch<T>(job: Type<JobHandler<T>>, payload: T): boolean`: lê os metadados da classe (`Reflector.get(Job.KEY, job)`), valida que o job está registrado e chama `sendToQueue(...)` com `{ persistent: true, contentType: "application/json", type: name }`. Publica direto, **sem registro na tabela `jobs`**: para jobs duráveis use `JobStore.enqueue` na transação do dado de negócio.
- `publish(queue, name, payload, messageId?): Promise<void>`: igual ao `dispatch`, mas usa o `ConfirmChannel` e só resolve quando o broker confirma; é o que o `JobPublisher` usa.
- Topologia por fila `Q`: `Q` (principal), `Q.dlq` e, para cada `backoffMs` distinto entre os jobs com `retries > 0`, `Q.retry.<backoffMs>ms` (`x-message-ttl: backoffMs`, `x-dead-letter-exchange: ""`, `x-dead-letter-routing-key: Q`, que devolve a mensagem à principal depois do atraso). Não coloque argumentos na fila principal: alterar os de uma fila existente dá `PRECONDITION_FAILED`.
- Workers: um canal por fila, `prefetch(QUEUE_CONCURRENCY[queue] ?? 1)` (concorrência **por fila**, em `src/queue/queue.config.ts`), `consume`. Para cada mensagem: log `📥 [queue/job] Recebido`; se houver `messageId`, `claim` na tabela `jobs` (ver acima); `await handler.handle(JSON.parse(...))`; `complete`; `ack`.
- Falhas:
  - Job desconhecido ou JSON inválido: vai direto à `Q.dlq` (sem retry), com `ack` na original.
  - Erro no `handle`: se `x-attempt < retries`, republica em `Q.retry.<backoffMs>ms` com `x-attempt + 1` (log `🔁`) e dá `ack` na original; senão publica em `Q.dlq` (log `💀`). A DLQ guarda corpo, `type` e os headers `x-attempt`, `x-error` e `x-failed-at`.
  - Se o próprio encaminhamento falhar, `nack(raw, false, true)` devolve a mensagem à fila (nada é perdido).
  - A entrega é "pelo menos uma vez" (publica a cópia, depois confirma): jobs devem ser idempotentes.
- Queda do RabbitMQ: o app **não cai e reconecta sozinho** (backoff exponencial, sem limite depois de conectado; no boot, desiste após `RABBITMQ_INITIAL_CONNECT_RETRIES` e a aplicação sai com erro).
  - `error` da conexão e dos canais viram `warn` (listeners obrigatórios: `error` sem listener derruba o processo).
  - Em `disconnect`, `dispatch` e `publish` falham com `Error("Fila indisponível: sem conexão com o RabbitMQ")`. O `POST /orders` **não é afetado** (responde 201): o job fica `pending` na tabela `jobs` e o `JobPublisher` o publica quando a conexão voltar.
  - Se um canal fechar sozinho com a conexão aberta, o service fecha a conexão para forçar a recuperação.
  - `ack`/`nack` ficam fora do `try` do job: falha ao confirmar não é falha do job. Mensagens em voo ficam sem confirmação e o broker as reentrega após a reconexão (jobs idempotentes).
- `onApplicationShutdown`: encerra a recuperação e fecha canais consumidores, canal publicador e a conexão.
- Erros: job não registrado -> `Error('Job "x" não registrado na fila y')`; `dispatch` antes da conexão ou durante a queda -> `Error("Fila indisponível: ...")`; nome duplicado na mesma fila -> `Error("Job duplicado: queue/name")` na descoberta.

Logs esperados na subida (via `Logger`):

```
🐇 Conectado ao RabbitMQ (filas: order_processing)
👷 Worker consumindo a fila order_processing (jobs: process_order; concorrência: 1)
```

## Regras

- Workers **nunca** enviam e-mails reais; apenas logs genéricos: 📥 Recebido -> ⚙️ Processando -> ✅ Concluído.
- `QueueModule` é `@Global()`, depende de `DiscoveryModule` (`imports: [DiscoveryModule]`), provê `QueueService`, `JobStore` e `JobPublisher` e exporta `QueueService` e `JobStore`.
- Para novos jobs: um arquivo `*.job.ts`, classe `@Injectable() @Job(...)`, registrada em `providers`.
- Ordem de boot: a fila conecta no `onModuleInit`, antes de `app.listen`; o `JobPublisher` só começa no `onApplicationBootstrap`, depois de a fila estar pronta.
- Constantes de ajuste em `src/queue/queue.config.ts`: `QUEUE_CONCURRENCY`, `RABBITMQ_INITIAL_CONNECT_RETRIES`, `JOB_LEASE_MS`, `REQUEUE_DELAY_MS`, `JOB_PUBLISH_INTERVAL_MS`, `JOB_PUBLISH_BATCH_SIZE`, `JOB_RETENTION_MS` e `JOB_PURGE_EVERY_SWEEPS`.
