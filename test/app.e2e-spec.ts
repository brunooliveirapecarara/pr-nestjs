import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DRIZZLE, MYSQL_POOL } from '../src/database/database.constants.js';
import { QueueService } from '../src/queue/queue.service.js';
import { AppModule } from '../src/app.module.js';

describe('App (e2e)', () => {
  const values = vi.fn();
  const dispatch = vi.fn();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    values.mockResolvedValue([{ insertId: 7 }]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MYSQL_POOL)
      .useValue({ end: vi.fn() })
      .overrideProvider(DRIZZLE)
      .useValue({ insert: () => ({ values }) })
      .overrideProvider(QueueService)
      .useValue({ dispatch, onModuleInit: vi.fn() })
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
    dispatch.mockClear();
    values.mockClear();
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
    expect(values).toHaveBeenCalledWith({
      customerEmail: 'a@b.com',
      product: 'Teclado',
      amount: '19.99',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
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
    expect(values).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('POST /orders responde 500 quando a fila está indisponível', async () => {
    dispatch.mockImplementationOnce(() => {
      throw new Error('Fila indisponível: sem conexão com o RabbitMQ');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { customer_email: 'a@b.com', product: 'Teclado', amount: 1 },
    });

    expect(response.statusCode).toBe(500);
  });
});
