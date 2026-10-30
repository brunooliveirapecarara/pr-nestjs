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
