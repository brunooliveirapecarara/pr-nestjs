import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DRIZZLE, MYSQL_POOL } from '../src/database/database.constants.js';
import { orders } from '../src/database/schema.js';
import { JobPublisher } from '../src/queue/job-publisher.service.js';
import { QueueService } from '../src/queue/queue.service.js';
import { AppModule } from '../src/app.module.js';

describe('App (e2e)', () => {
  const orderValues = vi.fn();
  const jobValues = vi.fn();
  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: table === orders ? orderValues : jobValues,
    })),
  };
  const transaction = vi.fn(
    async (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
  );
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MYSQL_POOL)
      .useValue({ end: vi.fn() })
      .overrideProvider(DRIZZLE)
      .useValue({ transaction })
      .overrideProvider(QueueService)
      .useValue({})
      .overrideProvider(JobPublisher)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    orderValues.mockResolvedValue([{ insertId: 7 }]);
    jobValues.mockResolvedValue(undefined);
  });

  it('GET /health retorna 200 com status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('POST /orders cria o pedido e responde 201 sem campos extras', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        customer_email: 'a@b.com',
        product: 'Teclado',
        amount: 19.99,
        extra: 'ignorado',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: 7,
      customer_email: 'a@b.com',
      product: 'Teclado',
      amount: 19.99,
    });
    expect(orderValues).toHaveBeenCalledWith({
      customerEmail: 'a@b.com',
      product: 'Teclado',
      amount: '19.99',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(jobValues).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      queue: 'order_processing',
      name: 'process_order',
      payload: {
        orderId: 7,
        customerEmail: 'a@b.com',
        product: 'Teclado',
        amount: 19.99,
      },
      createdAt: expect.any(Date),
    });
  });

  it.each([
    ['e-mail inválido', { customer_email: 'x', product: 'P', amount: 1 }],
    ['produto vazio', { customer_email: 'a@b.com', product: '', amount: 1 }],
    ['valor negativo', { customer_email: 'a@b.com', product: 'P', amount: -1 }],
    [
      'valor com mais de duas casas',
      { customer_email: 'a@b.com', product: 'P', amount: 10.123 },
    ],
    ['corpo vazio', {}],
  ])('POST /orders responde 400 com %s', async (_nome, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
    expect(orderValues).not.toHaveBeenCalled();
    expect(jobValues).not.toHaveBeenCalled();
  });

  it('POST /orders responde 500 quando o job não pode ser gravado', async () => {
    jobValues.mockRejectedValueOnce(new Error('falha ao gravar o job'));

    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { customer_email: 'a@b.com', product: 'Teclado', amount: 1 },
    });

    expect(response.statusCode).toBe(500);
  });

  it('POST /orders responde 201 mesmo com a fila indisponível (o publicador envia depois)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { customer_email: 'a@b.com', product: 'Teclado', amount: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(jobValues).toHaveBeenCalledTimes(1);
  });
});
