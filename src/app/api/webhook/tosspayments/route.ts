import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const webhookSchema = z.object({
  eventType: z.string(),
  data: z.object({
    paymentKey: z.string(),
    orderId: z.string(),
    status: z.string(),
    totalAmount: z.number(),
  }),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = webhookSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { eventType, data } = parsed.data;

  if (eventType !== "PAYMENT_STATUS_CHANGED" || data.status !== "DONE") {
    return NextResponse.json({ ok: true });
  }

  // 결제 완료 → Payment 업데이트 → Ticket 생성 (커뮤니티 접근 권한 부여)
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.update({
      where: { orderId: data.orderId },
      data: {
        status: "COMPLETED",
        tossPaymentKey: data.paymentKey,
      },
    });

    // Ticket이 아직 없는 경우에만 생성 (중복 웹훅 방지)
    const existingTicket = await tx.ticket.findUnique({
      where: { paymentId: payment.id },
    });

    if (!existingTicket) {
      // orderId 형식: {concertId}_{userId}_{timestamp}
      const [concertId, userId] = payment.orderId.split("_");

      await tx.ticket.create({
        data: {
          userId,
          concertId,
          paymentId: payment.id,
          quantity: Math.floor(payment.amount / 1), // 가격으로 수량 역산 (추후 개선)
        },
      });

      await tx.concert.update({
        where: { id: concertId },
        data: { soldTickets: { increment: 1 } },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
