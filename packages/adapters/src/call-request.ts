import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import type { CallRequestBlock } from "@rakazo/core";
import {
  CALL_CLIENT_NONCE_PREFIX,
  CALL_REQUEST_COOLDOWN_MS,
  CALL_REQUEST_RING_MS,
  callRequestBlock,
  callRequestClientNonce,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";

const REASON_MAX = 120;
const OPENING_MAX = 240;

export type CallRequestStatus = CallRequestBlock["status"];

/** Why the bot may not ring the user right now, or null when it may. */
export async function callRequestRefusal(
  prisma: PrismaClient,
  input: { userId: string; threadId: string; groupChat: boolean; now?: number },
): Promise<string | null> {
  if (input.groupChat) return "Calls work in a one-to-one chat only. Send a message instead.";
  const voice = await prisma.userVoiceCredential.findFirst({
    where: { userId: input.userId },
    select: { id: true },
  });
  if (!voice) {
    return "The user has not connected a voice provider, so they cannot take a call. Send a message instead.";
  }
  const since = new Date((input.now ?? Date.now()) - CALL_REQUEST_COOLDOWN_MS);
  const recent = await prisma.message.findFirst({
    where: {
      threadId: input.threadId,
      role: "bot",
      clientNonce: { startsWith: CALL_CLIENT_NONCE_PREFIX, endsWith: ":request" },
      createdAt: { gt: since },
    },
    select: { id: true },
  });
  if (recent) {
    return "You already called the user in the last 10 minutes. Send a message instead of calling again.";
  }
  return null;
}

export function newCallRequest(input: {
  reason: string;
  opening: string;
  now?: number;
}):
  | { error: string }
  | { callId: string; clientNonce: string; expiresAt: Date; blocks: MessageBlock[] } {
  const reason = input.reason.trim().slice(0, REASON_MAX);
  const opening = input.opening.trim().slice(0, OPENING_MAX);
  if (!reason) return { error: "reason is required." };
  if (!opening) return { error: "opening is required." };
  const callId = randomUUID();
  const expiresAt = new Date((input.now ?? Date.now()) + CALL_REQUEST_RING_MS);
  return {
    callId,
    clientNonce: callRequestClientNonce(callId),
    expiresAt,
    blocks: [
      {
        kind: "call_request",
        callId,
        reason,
        opening,
        status: "ringing",
        expiresAt: expiresAt.toISOString(),
      },
    ],
  };
}

/**
 * Moves the bot's call on from one of `from` and tells the thread. Returns the
 * updated block, or null when the call is unknown or already moved on, so two
 * devices answering, or an answer racing the ring-out, settle exactly once.
 */
export async function settleCallRequest(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "append"> },
  input: {
    threadId: string;
    callId: string;
    from: CallRequestStatus[];
    status?: CallRequestStatus;
    durationSeconds?: number;
  },
): Promise<CallRequestBlock | null> {
  const message = await deps.prisma.message.findUnique({
    where: {
      threadId_clientNonce: {
        threadId: input.threadId,
        clientNonce: callRequestClientNonce(input.callId),
      },
    },
    select: { id: true, blocks: true, botId: true, thread: { select: { spaceId: true } } },
  });
  if (!message?.botId) return null;
  const before = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
  const block = callRequestBlock(before);
  if (!block || !input.from.includes(block.status)) return null;
  const next: CallRequestBlock = {
    ...block,
    ...(input.status ? { status: input.status } : {}),
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
  };
  const blocks = [next, ...before.slice(1)];
  // Compare-and-set on the stored blocks: a concurrent settle leaves this one a no-op.
  const updated = await deps.prisma.message.updateMany({
    where: { id: message.id, blocks: { equals: message.blocks as Prisma.InputJsonValue } },
    data: { blocks: blocks as Prisma.InputJsonValue },
  });
  if (updated.count !== 1) return null;
  await deps.events.append({
    spaceId: message.thread.spaceId,
    threadId: input.threadId,
    botId: message.botId,
    type: "thread.message.updated",
    payload: { messageId: message.id, role: "bot", blocks, callId: input.callId },
  });
  return next;
}
