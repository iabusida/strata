import {
  AssetType,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionStatus,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

export interface OpenPositionRequest {
  userId: string;
  symbol: string;
  assetType: AssetType;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  broker?: string;
  brokerPositionId?: string;
  brokerAccount?: string;
  stopLoss?: number;
  takeProfit?: number;
  notes?: string;
}

export interface PlaceOrderRequest {
  userId: string;
  symbol: string;
  assetType: AssetType;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  broker: string;
  brokerAccount?: string;
  positionId?: string; // link to existing position
  stopLoss?: number;
  takeProfit?: number;
}

export interface UpdatePositionRequest {
  stopLoss?: number;
  takeProfit?: number;
  currentPrice?: number;
  notes?: string;
}

export async function openPosition(req: OpenPositionRequest) {
  const position = await prisma.position.create({
    data: {
      userId: req.userId,
      symbol: req.symbol,
      assetType: req.assetType,
      side: req.side,
      quantity: req.quantity,
      entryPrice: req.entryPrice,
      currentPrice: req.entryPrice,
      pnl: 0,
      pnlPercent: 0,
      brokerAccount: req.brokerAccount,
      brokerPositionId: req.brokerPositionId,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      notes: req.notes,
      entryAt: new Date(),
    },
  });

  return position;
}

export async function placeOrder(req: PlaceOrderRequest) {
  const order = await prisma.order.create({
    data: {
      userId: req.userId,
      symbol: req.symbol,
      assetType: req.assetType,
      side: req.side,
      type: req.type,
      quantity: req.quantity,
      price: req.price,
      broker: req.broker,
      brokerAccount: req.brokerAccount,
      positionId: req.positionId,
      status: OrderStatus.PENDING,
    },
  });

  return order;
}

export async function getUserPositions(userId: string) {
  const positions = await prisma.position.findMany({
    where: { userId },
    include: { orders: true },
    orderBy: { updatedAt: "desc" },
  });

  return positions.map((p: any) => ({
    ...p,
    pnl: calculatePnL(p.side, p.quantity, p.entryPrice, p.currentPrice).pnl,
    pnlPercent: calculatePnL(
      p.side,
      p.quantity,
      p.entryPrice,
      p.currentPrice
    ).pnlPercent,
  }));
}

export async function getPosition(positionId: string) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { orders: true },
  });

  if (!position) return null;

  return {
    ...position,
    pnl: calculatePnL(position.side, position.quantity, position.entryPrice, position.currentPrice)
      .pnl,
    pnlPercent: calculatePnL(
      position.side,
      position.quantity,
      position.entryPrice,
      position.currentPrice
    ).pnlPercent,
  };
}

export async function updatePosition(
  positionId: string,
  updates: UpdatePositionRequest
) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
  });

  if (!position) throw new Error("Position not found");

  const data: any = {};
  if (updates.stopLoss !== undefined) data.stopLoss = updates.stopLoss;
  if (updates.takeProfit !== undefined) data.takeProfit = updates.takeProfit;
  if (updates.notes !== undefined) data.notes = updates.notes;

  // Update PnL if current price changes
  if (updates.currentPrice !== undefined) {
    data.currentPrice = updates.currentPrice;
    const { pnl, pnlPercent } = calculatePnL(
      position.side,
      position.quantity,
      position.entryPrice,
      updates.currentPrice
    );
    data.pnl = pnl;
    data.pnlPercent = pnlPercent;
  }

  const updated = await prisma.position.update({
    where: { id: positionId },
    data,
    include: { orders: true },
  });

  return updated;
}

export async function closePosition(
  positionId: string,
  closePrice: number,
  reason?: string
) {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
  });

  if (!position) throw new Error("Position not found");
  if (position.status === PositionStatus.CLOSED)
    throw new Error("Position already closed");

  const { pnl } = calculatePnL(
    position.side,
    position.quantity,
    position.entryPrice,
    closePrice
  );

  const closed = await prisma.position.update({
    where: { id: positionId },
    data: {
      status: PositionStatus.CLOSED,
      closedAt: new Date(),
      closePrice,
      realizedPnl: pnl,
      notes: reason ? `${position.notes || ""} [CLOSED: ${reason}]` : undefined,
    },
    include: { orders: true },
  });

  return closed;
}

export async function getUserOrders(userId: string) {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return orders;
}

export async function getOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
  });
}

export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  filledQuantity?: number,
  filledPrice?: number
) {
  const data: any = { status };

  if (status === OrderStatus.FILLED) {
    data.filledAt = new Date();
    data.filledQuantity = filledQuantity;
    data.filledPrice = filledPrice;
  }

  if (status === OrderStatus.CANCELLED) {
    data.cancelledAt = new Date();
  }

  if (status === OrderStatus.REJECTED) {
    data.rejectedAt = new Date();
  }

  return prisma.order.update({
    where: { id: orderId },
    data,
  });
}

export async function cancelOrder(orderId: string, reason?: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) throw new Error("Order not found");
  if (
    order.status === OrderStatus.FILLED ||
    order.status === OrderStatus.CANCELLED
  ) {
    throw new Error(`Cannot cancel order with status ${order.status}`);
  }

  return prisma.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.CANCELLED,
      cancelledAt: new Date(),
      rejectionReason: reason,
    },
  });
}

function calculatePnL(
  side: OrderSide,
  quantity: number,
  entryPrice: number,
  exitPrice: number
) {
  const priceDelta = exitPrice - entryPrice;
  const pnl = side === OrderSide.LONG ? priceDelta * quantity : -priceDelta * quantity;
  const pnlPercent = (pnl / (entryPrice * quantity)) * 100;

  return { pnl, pnlPercent };
}
