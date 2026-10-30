import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  type RecoveringChannelModel,
} from 'amqplib';
import { env } from '../config/env.js';
import {
  DEFAULT_JOB_BACKOFF_MS,
  DEFAULT_JOB_RETRIES,
  Job,
  type JobHandler,
  type JobOptions,
} from './job.decorator.js';
import {
  DEFAULT_QUEUE_CONCURRENCY,
  QUEUE_CONCURRENCY,
  RABBITMQ_INITIAL_CONNECT_RETRIES,
} from './queue.config.js';

/**
 * Job descoberto, com a instância e a política de retry já resolvida.
 */
interface RegisteredJob {
  handler: JobHandler<unknown>;
  retries: number;
  backoffMs: number;
}

/**
 * Registry de jobs descobertos: fila -> nome do job -> job registrado.
 */
type JobRegistry = Map<string, Map<string, RegisteredJob>>;

/**
 * Resultado da execução de uma mensagem, a ser resolvido (ack, retry ou DLQ) em seguida.
 */
type Outcome =
  | { status: 'done' }
  | { status: 'dead'; error: unknown }
  | { status: 'failed'; job: RegisteredJob; error: unknown };

/**
 * Gerencia a conexão com o RabbitMQ, descobre os jobs `@Job()`, publica mensagens e executa os workers,
 * com retry atrasado por job e DLQ por fila.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly registry: JobRegistry = new Map();
  private consumerChannels: Channel[] = [];
  private connection: RecoveringChannelModel | null = null;
  private publisherChannel: Channel | null = null;
  private shuttingDown = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Descobre os jobs registrados e conecta ao RabbitMQ com recuperação automática. A topologia, o canal
   * publicador e os workers são montados no `setup`, que o amqplib reexecuta a cada reconexão.
   *
   * @returns Promise resolvida quando a primeira conexão, a topologia e os workers estiverem prontos.
   * @throws Error se houver job duplicado na mesma fila ou se o RabbitMQ seguir indisponível após as
   * retentativas iniciais.
   */
  async onModuleInit(): Promise<void> {
    this.discoverJobs();

    this.connection = await connect(env.RABBITMQ_URL, {
      recovery: {
        initialMaxRetries: RABBITMQ_INITIAL_CONNECT_RETRIES,
        maxRetries: Infinity,
        waitForConnect: false,
        setup: (model: ChannelModel) => this.setupConnection(model),
      },
    });
    this.watchConnection(this.connection);
    await this.connection.waitForConnect();
  }

  /**
   * Encerra a recuperação automática e fecha os canais e a conexão com o RabbitMQ.
   *
   * @returns Promise resolvida quando tudo estiver fechado.
   */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const channel of this.consumerChannels.splice(0)) {
      await channel.close().catch(() => undefined);
    }
    await this.publisherChannel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.publisherChannel = null;
    this.connection = null;
  }

  /**
   * Publica um job em sua fila de forma persistente.
   *
   * @param job - Classe do job, decorada com `@Job()` e registrada em `providers`.
   * @param payload - Dados entregues ao `handle` do job.
   * @returns `true` se a mensagem foi aceita pelo buffer do canal.
   * @throws Error se a fila não foi inicializada ou se o job não está registrado.
   */
  dispatch<TPayload>(
    job: Type<JobHandler<TPayload>>,
    payload: TPayload,
  ): boolean {
    if (!this.publisherChannel) {
      throw new Error('Fila indisponível: sem conexão com o RabbitMQ');
    }

    const options = this.reflector.get<JobOptions | undefined>(Job.KEY, job);
    if (!options || !this.registry.get(options.queue)?.has(options.name)) {
      throw new Error(
        `Job "${options?.name ?? job.name}" não registrado na fila ${options?.queue}`,
      );
    }

    return this.publisherChannel.sendToQueue(
      options.queue,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        contentType: 'application/json',
        type: options.name,
      },
    );
  }

  /**
   * Monta o registry a partir dos providers decorados com `@Job()`.
   *
   * @returns Nada; preenche `registry`.
   * @throws Error se dois jobs tiverem o mesmo nome na mesma fila.
   */
  private discoverJobs(): void {
    const providers = this.discovery.getProviders({ metadataKey: Job.KEY });

    for (const wrapper of providers) {
      const handler = wrapper.instance as JobHandler<unknown> | null;
      if (!handler) continue;

      const { queue, name, retries, backoffMs } =
        this.discovery.getMetadataByDecorator(Job, wrapper) as JobOptions;
      const jobs = this.registry.get(queue) ?? new Map();
      if (jobs.has(name)) {
        throw new Error(`Job duplicado: ${queue}/${name}`);
      }
      jobs.set(name, {
        handler,
        retries: retries ?? DEFAULT_JOB_RETRIES,
        backoffMs: backoffMs ?? DEFAULT_JOB_BACKOFF_MS,
      });
      this.registry.set(queue, jobs);
    }
  }

  /**
   * Declara, para cada fila, a fila principal, a DLQ e uma fila de retry por atraso distinto.
   * As filas de retry expiram as mensagens (`x-message-ttl`) devolvendo-as à fila principal.
   *
   * @param channel - Canal usado para declarar a topologia.
   * @returns Promise resolvida quando todas as filas estiverem declaradas.
   * @throws Erro do amqplib se alguma declaração falhar.
   */
  private async assertTopology(channel: Channel): Promise<void> {
    for (const [queue, jobs] of this.registry) {
      await channel.assertQueue(queue, { durable: true });
      await channel.assertQueue(this.deadLetterQueueName(queue), {
        durable: true,
      });

      const backoffs = new Set(
        [...jobs.values()]
          .filter((job) => job.retries > 0)
          .map((job) => job.backoffMs),
      );
      for (const backoffMs of backoffs) {
        await channel.assertQueue(this.retryQueueName(queue, backoffMs), {
          durable: true,
          arguments: {
            'x-message-ttl': backoffMs,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': queue,
          },
        });
      }
    }
  }

  /**
   * Registra os logs de ciclo de vida da conexão e impede que erros de conexão derrubem o processo.
   *
   * @param connection - Conexão com recuperação automática.
   * @returns Nada.
   */
  private watchConnection(connection: RecoveringChannelModel): void {
    connection.on('error', (error) => {
      this.logger.warn(`⚠️ Erro na conexão com o RabbitMQ: ${error.message}`);
    });
    connection.on('disconnect', (error) => {
      this.publisherChannel = null;
      this.consumerChannels = [];
      this.logger.warn(
        `🔌 Conexão com o RabbitMQ perdida: ${error.message}. Tentando reconectar`,
      );
    });
    connection.on('reconnect-scheduled', ({ attempt, delay }) => {
      this.logger.warn(
        `🔄 Reconectando ao RabbitMQ (tentativa ${attempt} em ${delay}ms)`,
      );
    });
    connection.on('reconnect-failed', (error) => {
      this.logger.error(
        `❌ Reconexão com o RabbitMQ desistiu: ${error.message}`,
      );
    });
  }

  /**
   * Monta tudo o que depende da conexão: canal publicador, topologia e um worker por fila com jobs
   * (com a concorrência configurada para a fila). Executado a cada (re)conexão.
   *
   * @param model - Conexão recém-aberta com o RabbitMQ.
   * @returns Promise resolvida quando o publicador, a topologia e os workers estiverem prontos.
   * @throws Erro do amqplib se alguma declaração ou consumo falhar; o amqplib tenta de novo.
   */
  private async setupConnection(model: ChannelModel): Promise<void> {
    const publisher = await this.openChannel(model, 'publicador');
    await this.assertTopology(publisher);
    this.logger.log(
      `🐇 Conectado ao RabbitMQ (filas: ${[...this.registry.keys()].join(', ')})`,
    );

    const consumers: Channel[] = [];
    for (const [queue, jobs] of this.registry) {
      const concurrency = QUEUE_CONCURRENCY[queue] ?? DEFAULT_QUEUE_CONCURRENCY;
      const channel = await this.openChannel(model, `consumidor ${queue}`);
      await channel.prefetch(concurrency);
      await channel.consume(queue, (raw) => {
        if (raw) void this.handleMessage(channel, queue, raw);
      });
      consumers.push(channel);
      this.logger.log(
        `👷 Worker consumindo a fila ${queue} (jobs: ${[...jobs.keys()].join(', ')}; concorrência: ${concurrency})`,
      );
    }

    this.publisherChannel = publisher;
    this.consumerChannels = consumers;
  }

  /**
   * Abre um canal que não derruba o processo em caso de erro e que força a reconexão se fechar sozinho
   * (por exemplo, por um erro de protocolo) enquanto a conexão segue aberta.
   *
   * @param model - Conexão onde o canal é aberto.
   * @param label - Nome do canal, usado nos logs.
   * @returns Canal pronto para uso.
   * @throws Erro do amqplib se o canal não puder ser aberto.
   */
  private async openChannel(
    model: ChannelModel,
    label: string,
  ): Promise<Channel> {
    const channel = await model.createChannel();
    channel.on('error', (error: Error) => {
      this.logger.warn(`⚠️ Canal ${label} com erro: ${error.message}`);
    });
    channel.on('close', () => {
      if (this.shuttingDown) return;
      this.logger.warn(`🔌 Canal ${label} fechado; reiniciando a conexão`);
      void model.close().catch(() => undefined);
    });
    return channel;
  }

  /**
   * Executa a mensagem e resolve o resultado no broker. Falhas de infraestrutura ao resolver (canal ou
   * conexão caídos) nunca propagam: a mensagem segue sem confirmação e o broker a reentrega.
   *
   * @param channel - Canal do consumidor usado para confirmar a mensagem.
   * @param queue - Fila de onde a mensagem veio.
   * @param raw - Mensagem bruta entregue pelo RabbitMQ.
   * @returns Promise sempre resolvida, após `ack`, retry, DLQ ou a tentativa de devolver a mensagem.
   */
  private async handleMessage(
    channel: Channel,
    queue: string,
    raw: ConsumeMessage,
  ): Promise<void> {
    const outcome = await this.execute(queue, raw);
    const label = `[${queue}/${raw.properties.type as string}]`;

    try {
      if (outcome.status === 'done') {
        channel.ack(raw);
      } else if (outcome.status === 'dead') {
        await this.deadLetter(channel, queue, raw, outcome.error);
      } else {
        await this.retryOrDeadLetter(
          channel,
          queue,
          raw,
          outcome.job,
          outcome.error,
        );
      }
    } catch (error) {
      this.logger.error(
        `❌ ${label} Falha ao resolver a mensagem; devolvendo à fila`,
        error instanceof Error ? error.stack : String(error),
      );
      try {
        channel.nack(raw, false, true);
      } catch {
        this.logger.warn(
          `🔌 ${label} Canal indisponível; o broker reentregará a mensagem`,
        );
      }
    }
  }

  /**
   * Localiza o job da mensagem, deserializa o payload e executa o `handle`, sem tocar no broker.
   * Job desconhecido ou payload ilegível resultam em `dead` (sem retry); erro do `handle` em `failed`.
   *
   * @param queue - Fila de onde a mensagem veio.
   * @param raw - Mensagem bruta entregue pelo RabbitMQ.
   * @returns Resultado da execução; nunca lança.
   */
  private async execute(queue: string, raw: ConsumeMessage): Promise<Outcome> {
    const jobName = raw.properties.type as string | undefined;
    const job = jobName ? this.registry.get(queue)?.get(jobName) : undefined;

    this.logger.log(
      `📥 [${queue}/${jobName}] Recebido ${raw.content.toString()}`,
    );

    if (!job) {
      return {
        status: 'dead',
        error: new Error(`Job "${jobName}" não registrado na fila ${queue}`),
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.content.toString());
    } catch (error) {
      return { status: 'dead', error };
    }

    try {
      await job.handler.handle(payload);
      return { status: 'done' };
    } catch (error) {
      return { status: 'failed', job, error };
    }
  }

  /**
   * Reenvia a mensagem para a fila de retry do job, ou à DLQ quando as tentativas se esgotaram.
   *
   * @param channel - Canal do consumidor usado para confirmar a mensagem original.
   * @param queue - Fila de onde a mensagem veio.
   * @param raw - Mensagem que falhou.
   * @param job - Job que falhou, com a política de retry.
   * @param error - Erro lançado pelo `handle`.
   * @returns Promise resolvida após a mensagem ser reenviada e confirmada.
   * @throws Error se o canal publicador não estiver disponível.
   */
  private async retryOrDeadLetter(
    channel: Channel,
    queue: string,
    raw: ConsumeMessage,
    job: RegisteredJob,
    error: unknown,
  ): Promise<void> {
    const attempt = this.attemptOf(raw);
    const label = `[${queue}/${raw.properties.type as string}]`;

    if (attempt >= job.retries) {
      this.logger.error(
        `❌ ${label} Falhou após ${attempt} retentativa(s)`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.deadLetter(channel, queue, raw, error);
      return;
    }

    this.logger.warn(
      `🔁 ${label} Falhou (${this.describe(error)}); tentativa ${attempt + 1}/${job.retries} em ${job.backoffMs}ms`,
    );
    this.republish(this.retryQueueName(queue, job.backoffMs), raw, {
      'x-attempt': attempt + 1,
    });
    channel.ack(raw);
  }

  /**
   * Envia a mensagem à DLQ da fila, anexando o erro, e a confirma na fila original.
   *
   * @param channel - Canal do consumidor usado para confirmar a mensagem original.
   * @param queue - Fila de onde a mensagem veio.
   * @param raw - Mensagem a descartar.
   * @param error - Motivo da falha.
   * @returns Promise resolvida após a mensagem ser publicada na DLQ e confirmada.
   * @throws Error se o canal publicador não estiver disponível.
   */
  private async deadLetter(
    channel: Channel,
    queue: string,
    raw: ConsumeMessage,
    error: unknown,
  ): Promise<void> {
    const dlq = this.deadLetterQueueName(queue);
    this.republish(dlq, raw, {
      'x-attempt': this.attemptOf(raw),
      'x-error': this.describe(error),
      'x-failed-at': new Date().toISOString(),
    });
    channel.ack(raw);
    this.logger.error(
      `💀 [${queue}/${raw.properties.type as string}] Enviado para ${dlq}: ${this.describe(error)}`,
    );
  }

  /**
   * Publica uma cópia da mensagem em outra fila, preservando corpo e tipo e mesclando headers.
   *
   * @param target - Fila de destino.
   * @param raw - Mensagem original.
   * @param headers - Headers a acrescentar aos já existentes.
   * @returns Nada.
   * @throws Error se o canal publicador não estiver disponível.
   */
  private republish(
    target: string,
    raw: ConsumeMessage,
    headers: Record<string, string | number>,
  ): void {
    if (!this.publisherChannel) {
      throw new Error('Fila não inicializada');
    }
    this.publisherChannel.sendToQueue(target, raw.content, {
      persistent: true,
      contentType: raw.properties.contentType as string | undefined,
      type: raw.properties.type as string | undefined,
      headers: { ...raw.properties.headers, ...headers },
    });
  }

  /**
   * Lê quantas retentativas a mensagem já consumiu.
   *
   * @param raw - Mensagem recebida.
   * @returns Valor do header `x-attempt`, ou 0 na primeira entrega.
   */
  private attemptOf(raw: ConsumeMessage): number {
    return Number(raw.properties.headers?.['x-attempt'] ?? 0);
  }

  /**
   * Extrai uma descrição curta de um erro desconhecido.
   *
   * @param error - Valor capturado em um `catch`.
   * @returns Mensagem do erro, ou o valor convertido para texto.
   */
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Nome da DLQ de uma fila.
   *
   * @param queue - Fila principal.
   * @returns Nome no formato `<fila>.dlq`.
   */
  private deadLetterQueueName(queue: string): string {
    return `${queue}.dlq`;
  }

  /**
   * Nome da fila de retry de uma fila para um determinado atraso.
   *
   * @param queue - Fila principal.
   * @param backoffMs - Atraso em milissegundos.
   * @returns Nome no formato `<fila>.retry.<atraso>ms`.
   */
  private retryQueueName(queue: string, backoffMs: number): string {
    return `${queue}.retry.${backoffMs}ms`;
  }
}
