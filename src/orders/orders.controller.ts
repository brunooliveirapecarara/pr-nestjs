import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { CreateOrderDto, OrderResponseDto } from './order.schema.js';
import { OrdersService } from './orders.service.js';

/**
 * Endpoints HTTP de pedidos.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * Cria um pedido, persiste e o enfileira para processamento.
   *
   * @param body - Corpo `{ customer_email, product, amount }` já validado pelo pipe global.
   * @returns O pedido criado, com status 201.
   * @throws Erro do driver se a gravação no banco falhar.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodSerializerDto(OrderResponseDto)
  create(@Body() body: CreateOrderDto): Promise<OrderResponseDto> {
    return this.ordersService.create(body);
  }
}
