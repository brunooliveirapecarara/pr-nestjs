import { EventEmitter } from 'node:events';
import { Injectable, Module, type LoggerService } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import type { ConsumeMessage } from 'amqplib';
import { env } from '../config/env.js';
import { Job, type JobHandler } from './job.decorator.js';
import { JobPublisher } from './job-publisher.service.js';
import { JobStore } from './job-store.service.js';
import { QueueModule } from './queue.module.js';
import { QueueService } from './queue.service.js';

type Consumer = (message: ConsumeMessage | null) => void;

const amqp = vi.hoisted(() => {
  const channel = {
    assertQueue: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(),
    sendToQueue: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
  return {
    channel,
    connection: {
      createChannel: vi.fn(),
      createConfirmChannel: vi.fn(),
      close: vi.fn(),
    },
    connect: vi.fn(),
  };
});

/**
 * Conexão com recuperação falsa: `waitForConnect` executa o `setup` do amqplib como na primeira conexão,
 * e `reconnect` o reexecuta como numa reconexão.
 */
class FakeRecovering extends EventEmitter {
  close = vi.fn().mockResolvedValue(undefined);

  constructor(
    readonly options: {
      recovery: { setup: (model: unknown) => Promise<void> };
    },
  ) {
    super();
  }

  async waitForConnect(): Promise<this> {
    await this.options.recovery.setup(amqp.connection);
    return this;
  }

  async reconnect(): Promise<void> {
    await this.options.recovery.setup(amqp.connection);
    this.emit('connect', amqp.connection);
  }
}

vi.mock('amqplib', () => ({ connect: amqp.connect }));

vi.mock('./queue.config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue.config.js')>()),
  REQUEUE_DELAY_MS: 0,
}));

const store = {
  claim: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
  fail: vi.fn(),
};

const silentLogger: LoggerService = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

const handle = vi.fn<(payload: unknown) => Promise<void>>();

/**
 * Job de teste com 2 retentativas e atraso de 100ms.
 */
@Injectable()
@Job({ queue: 'q', name: 'flaky', retries: 2, backoffMs: 100 })
class FlakyJob implements JobHandler<{ id: number }> {
  async handle(payload: { id: number }): Promise<void> {
    await handle(payload);
  }
}

/**
 * Job de teste sem retry (padrão).
 */
@Injectable()
@Job({ queue: 'q', name: 'once' })
class OnceJob implements JobHandler<{ id: number }> {
  async handle(payload: { id: number }): Promise<void> {
    await handle(payload);
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => env],
    }),
    QueueModule,
  ],
  providers: [FlakyJob, OnceJob],
})
class TestModule {}

/**
 * Monta uma mensagem do RabbitMQ para entregar ao consumidor.
 *
 * @param type - Nome do job em `properties.type`.
 * @param body - Corpo bruto da mensagem.
 * @param headers - Headers da mensagem.
 * @param messageId - Id do job na tabela `jobs`, quando a mensagem veio do outbox.
 * @returns Mensagem no formato `ConsumeMessage`.
 */
function message(
  type: string,
  body: string,
  headers: Record<string, unknown> = {},
  messageId?: string,
): ConsumeMessage {
  return {
    content: Buffer.from(body),
    properties: { type, contentType: 'application/json', headers, messageId },
  } as unknown as ConsumeMessage;
}

describe('QueueService', () => {
  let moduleRef: TestingModule;
  let service: QueueService;
  let deliver: Consumer;
  let recovering: FakeRecovering;

  /**
   * Entrega uma mensagem ao worker e espera ela ser confirmada ou devolvida.
   *
   * @param raw - Mensagem a entregar.
   * @returns Promise resolvida depois de `ack` ou `nack`.
   */
  async function consume(raw: ConsumeMessage): Promise<void> {
    deliver(raw);
    await vi.waitFor(() => {
      const settled =
        amqp.channel.ack.mock.calls.length +
        amqp.channel.nack.mock.calls.length;
      expect(settled).toBeGreaterThan(0);
    });
  }

  /**
   * Lista as publicações feitas na fila indicada.
   *
   * @param queue - Nome da fila de destino.
   * @returns Argumentos de cada `sendToQueue` para essa fila.
   */
  function sentTo(queue: string): unknown[][] {
    return amqp.channel.sendToQueue.mock.calls.filter(
      ([target]) => target === queue,
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    amqp.channel.ack.mockReset();
    amqp.channel.nack.mockReset();
    amqp.connection.createChannel.mockResolvedValue(amqp.channel);
    amqp.connection.createConfirmChannel.mockResolvedValue(amqp.channel);
    amqp.connection.close.mockResolvedValue(undefined);
    amqp.channel.close.mockResolvedValue(undefined);
    amqp.connect.mockImplementation(
      async (_url: string, options: FakeRecovering['options']) => {
        recovering = new FakeRecovering(options);
        return recovering;
      },
    );
    amqp.channel.sendToQueue.mockImplementation((...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === 'function') as
        ((error: unknown) => void) | undefined;
      callback?.(null);
      return true;
    });
    store.claim.mockResolvedValue('claimed');
    store.complete.mockResolvedValue(undefined);
    store.release.mockResolvedValue(undefined);
    store.fail.mockResolvedValue(undefined);
    amqp.channel.consume.mockImplementation(
      async (_queue: string, callback: Consumer) => {
        deliver = callback;
      },
    );
    handle.mockResolvedValue(undefined);

    moduleRef = await Test.createTestingModule({ imports: [TestModule] })
      .overrideProvider(JobStore)
      .useValue(store)
      .overrideProvider(JobPublisher)
      .useValue({})
      .setLogger(silentLogger)
      .compile();
    await moduleRef.init();
    service = moduleRef.get(QueueService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('topologia', () => {
    it('declara a fila, a DLQ e uma fila de retry por atraso', () => {
      const declared = amqp.channel.assertQueue.mock.calls.map(
        ([name]) => name,
      );

      expect(declared).toEqual(['q', 'q.dlq', 'q.retry.100ms']);
      expect(amqp.channel.assertQueue).toHaveBeenCalledWith('q.retry.100ms', {
        durable: true,
        arguments: {
          'x-message-ttl': 100,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': 'q',
        },
      });
    });

    it('usa a concorrência padrão (1) quando a fila não é configurada', () => {
      expect(amqp.channel.prefetch).toHaveBeenCalledWith(1);
    });
  });

  describe('dispatch', () => {
    it('publica a mensagem persistente com o nome do job em type', () => {
      service.dispatch(FlakyJob, { id: 1 });

      expect(amqp.channel.sendToQueue).toHaveBeenCalledWith(
        'q',
        Buffer.from('{"id":1}'),
        { persistent: true, contentType: 'application/json', type: 'flaky' },
      );
    });

    it('falha quando o job não está registrado', () => {
      class Unknown implements JobHandler<number> {
        async handle(): Promise<void> {}
      }

      expect(() => service.dispatch(Unknown, 1)).toThrow(/não registrado/);
    });

    it('falha antes da conexão ser inicializada', () => {
      const isolated = new QueueService(
        moduleRef.get(DiscoveryService),
        moduleRef.get(Reflector),
        store as unknown as JobStore,
        moduleRef.get(ConfigService),
      );

      expect(() => isolated.dispatch(FlakyJob, { id: 1 })).toThrow(
        'Fila indisponível',
      );
    });
  });

  describe('consumo', () => {
    it('confirma (ack) a mensagem processada com sucesso', async () => {
      const raw = message('flaky', '{"id":1}');

      await consume(raw);

      expect(handle).toHaveBeenCalledWith({ id: 1 });
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
      expect(amqp.channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('reenvia para a fila de retry com x-attempt incrementado', async () => {
      handle.mockRejectedValue(new Error('boom'));
      const raw = message('flaky', '{"id":1}');

      await consume(raw);

      const [[, content, options]] = sentTo('q.retry.100ms');
      expect(content).toEqual(raw.content);
      expect(options).toMatchObject({
        persistent: true,
        type: 'flaky',
        headers: { 'x-attempt': 1 },
      });
      expect(sentTo('q.dlq')).toHaveLength(0);
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
      expect(amqp.channel.nack).not.toHaveBeenCalled();
    });

    it('continua a contagem a partir do x-attempt recebido', async () => {
      handle.mockRejectedValue(new Error('boom'));

      await consume(message('flaky', '{"id":1}', { 'x-attempt': 1 }));

      const [[, , options]] = sentTo('q.retry.100ms');
      expect(options).toMatchObject({ headers: { 'x-attempt': 2 } });
    });

    it('envia à DLQ com o erro quando as tentativas se esgotam', async () => {
      handle.mockRejectedValue(new Error('boom'));
      const raw = message('flaky', '{"id":1}', { 'x-attempt': 2 });

      await consume(raw);

      expect(sentTo('q.retry.100ms')).toHaveLength(0);
      const [[, content, options]] = sentTo('q.dlq');
      expect(content).toEqual(raw.content);
      expect(options).toMatchObject({
        type: 'flaky',
        headers: { 'x-attempt': 2, 'x-error': 'boom' },
      });
      expect(options).toHaveProperty(['headers', 'x-failed-at']);
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
    });

    it('envia direto à DLQ um job sem retry configurado', async () => {
      handle.mockRejectedValue(new Error('boom'));

      await consume(message('once', '{"id":1}'));

      expect(sentTo('q.retry.100ms')).toHaveLength(0);
      expect(sentTo('q.dlq')).toHaveLength(1);
    });

    it('envia direto à DLQ um job desconhecido, sem tentar o handler', async () => {
      await consume(message('inexistente', '{"id":1}'));

      expect(handle).not.toHaveBeenCalled();
      const [[, , options]] = sentTo('q.dlq');
      expect(options).toMatchObject({
        headers: { 'x-attempt': 0 },
      });
      expect(sentTo('q.retry.100ms')).toHaveLength(0);
    });

    it('envia direto à DLQ um JSON inválido, sem retry', async () => {
      await consume(message('flaky', '{isso nao e json'));

      expect(handle).not.toHaveBeenCalled();
      expect(sentTo('q.dlq')).toHaveLength(1);
      expect(sentTo('q.retry.100ms')).toHaveLength(0);
    });

    it('devolve a mensagem à fila (nack com requeue) se o reenvio falhar', async () => {
      handle.mockRejectedValue(new Error('boom'));
      amqp.channel.sendToQueue.mockImplementation(() => {
        throw new Error('canal fechado');
      });
      const raw = message('flaky', '{"id":1}');

      await consume(raw);

      expect(amqp.channel.nack).toHaveBeenCalledWith(raw, false, true);
      expect(amqp.channel.ack).not.toHaveBeenCalled();
    });
  });

  describe('conexão com recuperação automática', () => {
    it('conecta com recovery e limite de retentativas só no boot', () => {
      expect(amqp.connect).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          recovery: expect.objectContaining({
            initialMaxRetries: 5,
            maxRetries: Infinity,
            waitForConnect: false,
          }),
        }),
      );
    });

    it('não derruba o processo com erro de conexão', () => {
      expect(() =>
        recovering.emit('error', new Error('ECONNRESET')),
      ).not.toThrow();
    });

    it('falha o dispatch enquanto desconectado e volta a publicar ao reconectar', async () => {
      recovering.emit('disconnect', new Error('CONNECTION-FORCED'));

      expect(() => service.dispatch(FlakyJob, { id: 1 })).toThrow(
        'Fila indisponível',
      );

      amqp.channel.assertQueue.mockClear();
      amqp.channel.consume.mockClear();
      await recovering.reconnect();

      expect(amqp.channel.assertQueue).toHaveBeenCalledWith('q', {
        durable: true,
      });
      expect(amqp.channel.consume).toHaveBeenCalledTimes(1);
      expect(service.dispatch(FlakyJob, { id: 2 })).toBe(true);
    });

    it('volta a consumir mensagens depois de reconectar', async () => {
      recovering.emit('disconnect', new Error('CONNECTION-FORCED'));
      await recovering.reconnect();
      const raw = message('flaky', '{"id":3}');

      await consume(raw);

      expect(handle).toHaveBeenCalledWith({ id: 3 });
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
    });

    it('reinicia a conexão quando um canal fecha sozinho', () => {
      const onClose = amqp.channel.on.mock.calls
        .filter(([event]) => event === 'close')
        .map(([, handler]) => handler as () => void);

      onClose[0]!();

      expect(amqp.connection.close).toHaveBeenCalledTimes(1);
    });

    it('não reinicia a conexão quando o canal fecha no encerramento', async () => {
      const onClose = amqp.channel.on.mock.calls
        .filter(([event]) => event === 'close')
        .map(([, handler]) => handler as () => void);

      await service.onApplicationShutdown();
      onClose[0]!();

      expect(amqp.connection.close).not.toHaveBeenCalled();
      expect(recovering.close).toHaveBeenCalledTimes(1);
    });

    it('não trata falha do ack como falha do job (sem retry nem DLQ)', async () => {
      amqp.channel.ack.mockImplementation(() => {
        throw new Error('Channel closed');
      });
      amqp.channel.nack.mockImplementation(() => undefined);

      await consume(message('flaky', '{"id":1}'));

      expect(handle).toHaveBeenCalledTimes(1);
      expect(amqp.channel.sendToQueue).not.toHaveBeenCalled();
      expect(amqp.channel.nack).toHaveBeenCalledWith(
        expect.anything(),
        false,
        true,
      );
    });

    it('não propaga erro quando ack e nack falham com o canal fechado', async () => {
      amqp.channel.ack.mockImplementation(() => {
        throw new Error('Channel closed');
      });
      amqp.channel.nack.mockImplementation(() => {
        throw new Error('Channel closed');
      });
      deliver(message('flaky', '{"id":1}'));

      await vi.waitFor(() => expect(amqp.channel.nack).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));

      expect(handle).toHaveBeenCalledTimes(1);
    });
  });

  describe('publish (confirmado)', () => {
    it('publica com o messageId e resolve quando o broker confirma', async () => {
      await service.publish('q', 'flaky', { id: 1 }, 'job-1');

      expect(amqp.channel.sendToQueue).toHaveBeenCalledWith(
        'q',
        Buffer.from('{"id":1}'),
        {
          persistent: true,
          contentType: 'application/json',
          type: 'flaky',
          messageId: 'job-1',
        },
        expect.any(Function),
      );
    });

    it('rejeita quando o broker não confirma a mensagem', async () => {
      amqp.channel.sendToQueue.mockImplementation((...args: unknown[]) => {
        (args.at(-1) as (error: unknown) => void)(new Error('nack do broker'));
        return true;
      });

      await expect(service.publish('q', 'flaky', {}, 'job-1')).rejects.toThrow(
        'nack do broker',
      );
    });

    it('rejeita job não registrado e fila indisponível', async () => {
      await expect(service.publish('q', 'inexistente', {})).rejects.toThrow(
        /não registrado/,
      );

      recovering.emit('disconnect', new Error('CONNECTION-FORCED'));
      await expect(service.publish('q', 'flaky', {})).rejects.toThrow(
        'Fila indisponível',
      );
    });
  });

  describe('registro do job (tabela jobs)', () => {
    const jobId = 'job-1';

    it('reivindica antes do handle e marca concluído depois', async () => {
      const raw = message('flaky', '{"id":1}', {}, jobId);

      await consume(raw);

      expect(store.claim).toHaveBeenCalledWith(jobId);
      expect(handle).toHaveBeenCalledWith({ id: 1 });
      expect(store.complete).toHaveBeenCalledWith(jobId);
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
      expect(store.claim.mock.invocationCallOrder[0]!).toBeLessThan(
        handle.mock.invocationCallOrder[0]!,
      );
    });

    it.each(['finished', 'missing'])(
      'ignora a duplicata (%s): confirma sem executar nem tocar no registro',
      async (claim) => {
        store.claim.mockResolvedValue(claim);
        const raw = message('flaky', '{"id":1}', {}, jobId);

        await consume(raw);

        expect(handle).not.toHaveBeenCalled();
        expect(store.complete).not.toHaveBeenCalled();
        expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
        expect(amqp.channel.nack).not.toHaveBeenCalled();
      },
    );

    it('devolve à fila (sem ack) um job que outro worker está executando', async () => {
      store.claim.mockResolvedValue('busy');
      const raw = message('flaky', '{"id":1}', {}, jobId);

      await consume(raw);

      expect(handle).not.toHaveBeenCalled();
      expect(amqp.channel.ack).not.toHaveBeenCalled();
      expect(amqp.channel.nack).toHaveBeenCalledWith(raw, false, true);
    });

    it('devolve à fila, sem retry nem DLQ, quando a tabela jobs está indisponível', async () => {
      store.claim.mockRejectedValue(new Error('db fora do ar'));
      const raw = message('flaky', '{"id":1}', {}, jobId);

      await consume(raw);

      expect(handle).not.toHaveBeenCalled();
      expect(amqp.channel.nack).toHaveBeenCalledWith(raw, false, true);
      expect(amqp.channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('registra a falha antes de reenviar ao retry e preserva o messageId', async () => {
      handle.mockRejectedValue(new Error('boom'));
      const raw = message('flaky', '{"id":1}', {}, jobId);

      await consume(raw);

      expect(store.release).toHaveBeenCalledWith(jobId, expect.any(Error));
      expect(store.release.mock.invocationCallOrder[0]!).toBeLessThan(
        amqp.channel.sendToQueue.mock.invocationCallOrder[0]!,
      );
      const [[, , options]] = sentTo('q.retry.100ms');
      expect(options).toMatchObject({ messageId: jobId });
      expect(store.fail).not.toHaveBeenCalled();
    });

    it('marca failed ao enviar à DLQ, preservando o messageId', async () => {
      handle.mockRejectedValue(new Error('boom'));

      await consume(message('flaky', '{"id":1}', { 'x-attempt': 2 }, jobId));

      const [[, , options]] = sentTo('q.dlq');
      expect(options).toMatchObject({ messageId: jobId });
      await vi.waitFor(() =>
        expect(store.fail).toHaveBeenCalledWith(jobId, expect.any(Error)),
      );
      expect(store.release).not.toHaveBeenCalled();
    });

    it('marca failed também para job desconhecido e payload inválido', async () => {
      await consume(message('inexistente', '{}', {}, jobId));
      await vi.waitFor(() => expect(store.fail).toHaveBeenCalledTimes(1));

      amqp.channel.ack.mockClear();
      await consume(message('flaky', '{isso nao e json', {}, 'job-2'));
      await vi.waitFor(() => expect(store.fail).toHaveBeenCalledTimes(2));
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('não perde a mensagem na DLQ se o registro não puder ser atualizado', async () => {
      handle.mockRejectedValue(new Error('boom'));
      store.fail.mockRejectedValue(new Error('db fora do ar'));
      const raw = message('flaky', '{"id":1}', { 'x-attempt': 2 }, jobId);

      await consume(raw);

      expect(sentTo('q.dlq')).toHaveLength(1);
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
    });

    it('devolve à fila, sem reenviar, se não conseguir registrar a falha', async () => {
      handle.mockRejectedValue(new Error('boom'));
      store.release.mockRejectedValue(new Error('db fora do ar'));
      const raw = message('flaky', '{"id":1}', {}, jobId);

      await consume(raw);

      expect(sentTo('q.retry.100ms')).toHaveLength(0);
      expect(amqp.channel.nack).toHaveBeenCalledWith(raw, false, true);
    });

    it('confirma a mensagem mesmo se não conseguir marcar o job como concluído', async () => {
      store.complete.mockRejectedValue(new Error('db fora do ar'));
      const raw = message('flaky', '{"id":1}', {}, jobId);

      await consume(raw);

      expect(handle).toHaveBeenCalledTimes(1);
      expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
    });

    it('não toca no registro quando a mensagem não tem messageId', async () => {
      await consume(message('flaky', '{"id":1}'));

      expect(handle).toHaveBeenCalledTimes(1);
      expect(store.claim).not.toHaveBeenCalled();
      expect(store.complete).not.toHaveBeenCalled();
    });
  });
});
