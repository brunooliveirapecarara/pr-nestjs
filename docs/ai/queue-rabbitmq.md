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
 * Processa um pedido apenas registrando o ciclo de vida, sem efeitos externos reais.
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

## QueueService — `src/queue/queue.service.ts` (responsabilidades)

- `onModuleInit`: usa `DiscoveryService.getProviders({ metadataKey: Job.KEY })` + `getMetadataByDecorator(Job, wrapper)` para montar o registry `Map<queue, Map<name, { handler, retries, backoffMs }>>`; conecta com recuperação automática (`amqp.connect(env.RABBITMQ_URL, { recovery: { initialMaxRetries: 5, maxRetries: Infinity, waitForConnect: false, setup } })`) e aguarda `waitForConnect()`. O `setup` do amqplib roda a cada (re)conexão e monta o canal publicador, a topologia (abaixo) e os workers: os canais não são recriados sozinhos.
- `dispatch<T>(job: Type<JobHandler<T>>, payload: T): boolean`: lê os metadados da classe (`Reflector.get(Job.KEY, job)`), valida que o job está registrado e chama `sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true, contentType: "application/json", type: name })`.
- Topologia por fila `Q`: `Q` (principal), `Q.dlq` e, para cada `backoffMs` distinto entre os jobs com `retries > 0`, `Q.retry.<backoffMs>ms` (`x-message-ttl: backoffMs`, `x-dead-letter-exchange: ""`, `x-dead-letter-routing-key: Q`, que devolve a mensagem à principal depois do atraso). Não coloque argumentos na fila principal: alterar os de uma fila existente dá `PRECONDITION_FAILED`.
- Workers: um canal por fila, `prefetch(QUEUE_CONCURRENCY[queue] ?? 1)` (concorrência **por fila**, em `src/queue/queue.config.ts`), `consume`. Para cada mensagem: log `📥 [queue/job] Recebido`, `await handler.handle(JSON.parse(...))`, `ack`.
- Falhas:
  - Job desconhecido ou JSON inválido: vai direto à `Q.dlq` (sem retry), com `ack` na original.
  - Erro no `handle`: se `x-attempt < retries`, republica em `Q.retry.<backoffMs>ms` com `x-attempt + 1` (log `🔁`) e dá `ack` na original; senão publica em `Q.dlq` (log `💀`). A DLQ guarda corpo, `type` e os headers `x-attempt`, `x-error` e `x-failed-at`.
  - Se o próprio encaminhamento falhar, `nack(raw, false, true)` devolve a mensagem à fila (nada é perdido).
  - A entrega é "pelo menos uma vez" (publica a cópia, depois confirma): jobs devem ser idempotentes.
- Queda do RabbitMQ: o app **não cai e reconecta sozinho** (backoff exponencial, sem limite depois de conectado; no boot, desiste após `RABBITMQ_INITIAL_CONNECT_RETRIES` e a aplicação sai com erro).
  - `error` da conexão e dos canais viram `warn` (listeners obrigatórios: `error` sem listener derruba o processo).
  - Em `disconnect`, `dispatch` lança `Error("Fila indisponível: sem conexão com o RabbitMQ")`, que o Nest responde como 500; o pedido do `POST /orders` já foi gravado no banco nesse caso.
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
- `QueueModule` é `@Global()` e depende de `DiscoveryModule` (`imports: [DiscoveryModule]`).
- Para novos jobs: um arquivo `*.job.ts`, classe `@Injectable() @Job(...)`, registrada em `providers`.
- Ordem de boot: a fila conecta no `onModuleInit`, antes de `app.listen`, para que `dispatch` nunca seja chamado sem conexão.
