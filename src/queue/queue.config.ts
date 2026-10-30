/**
 * Concorrência padrão de uma fila sem configuração própria: uma mensagem por vez.
 */
export const DEFAULT_QUEUE_CONCURRENCY = 1;

/**
 * Número máximo de mensagens processadas em paralelo por fila (`prefetch` do canal consumidor).
 * Filas ausentes usam `DEFAULT_QUEUE_CONCURRENCY`.
 */
export const QUEUE_CONCURRENCY: Readonly<Record<string, number>> = {
  order_processing: 1,
};

/**
 * Retentativas de conexão com o RabbitMQ no boot antes de derrubar a aplicação. Depois de conectada,
 * a reconexão é ilimitada (backoff exponencial do próprio amqplib).
 */
export const RABBITMQ_INITIAL_CONNECT_RETRIES = 5;

/**
 * Tempo máximo, em ms, que um job pode ficar em `processing` antes de outra entrega poder reassumi-lo
 * (cobre o worker que morreu no meio da execução).
 */
export const JOB_LEASE_MS = 5 * 60 * 1000;

/**
 * Espera, em ms, antes de devolver à fila uma mensagem que não pôde ser resolvida agora (job ainda em
 * execução em outro worker ou banco indisponível), para não girar em laço apertado.
 */
export const REQUEUE_DELAY_MS = 1000;

/**
 * Intervalo, em ms, entre as varreduras do publicador da tabela `jobs`.
 */
export const JOB_PUBLISH_INTERVAL_MS = 1000;

/**
 * Máximo de jobs `pending` publicados por varredura.
 */
export const JOB_PUBLISH_BATCH_SIZE = 50;

/**
 * Tempo, em ms, que jobs `done` ficam na tabela antes de serem apagados (`failed` nunca é apagado).
 */
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A cada quantas varreduras o publicador apaga os jobs `done` vencidos.
 */
export const JOB_PURGE_EVERY_SWEEPS = 600;
