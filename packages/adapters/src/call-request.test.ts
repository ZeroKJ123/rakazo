import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { callRequestRefusal, newCallRequest, settleCallRequest } from "./call-request.js";

function prismaWith(options: {
  voice?: boolean;
  recent?: boolean;
  status?: string;
  updated?: number;
}) {
  const blocks = [
    {
      kind: "call_request",
      callId: "call-1",
      reason: "Send the report",
      opening: "Hi, it's about the report.",
      status: options.status ?? "ringing",
      expiresAt: "2026-10-14T18:30:45Z",
    },
  ];
  return {
    userVoiceCredential: {
      findFirst: vi.fn(async () => (options.voice === false ? null : { id: "voice-1" })),
    },
    message: {
      findFirst: vi.fn(async () => (options.recent ? { id: "earlier" } : null)),
      findUnique: vi.fn(async () => ({
        id: "message-1",
        blocks,
        botId: "bot-1",
        thread: { spaceId: "space-1" },
      })),
      updateMany: vi.fn(async () => ({ count: options.updated ?? 1 })),
    },
  } as unknown as PrismaClient & {
    message: { updateMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  };
}

describe("call_user", () => {
  it("only rings a one-to-one chat with a voice provider, once per cooldown", async () => {
    const input = { userId: "user-1", threadId: "thread-1", groupChat: false };
    await expect(callRequestRefusal(prismaWith({}), input)).resolves.toBeNull();
    await expect(
      callRequestRefusal(prismaWith({}), { ...input, groupChat: true }),
    ).resolves.toMatch(/one-to-one/);
    await expect(callRequestRefusal(prismaWith({ voice: false }), input)).resolves.toMatch(
      /voice provider/,
    );
    await expect(callRequestRefusal(prismaWith({ recent: true }), input)).resolves.toMatch(
      /last 10 minutes/,
    );
  });

  it("looks for an earlier call only among this chat's own call requests", async () => {
    const prisma = prismaWith({});
    await callRequestRefusal(prisma, {
      userId: "user-1",
      threadId: "thread-1",
      groupChat: false,
      now: Date.parse("2026-10-14T18:30:00Z"),
    });
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread-1",
          clientNonce: { startsWith: "call:", endsWith: ":request" },
          createdAt: { gt: new Date("2026-10-14T18:20:00Z") },
        }),
      }),
    );
  });

  it("builds a ringing request that expires after the ring window", () => {
    const request = newCallRequest({
      reason: "  Send the report  ",
      opening: "Hi!",
      now: Date.parse("2026-10-14T18:30:00Z"),
    });
    if ("error" in request) throw new Error(request.error);
    expect(request.clientNonce).toBe(`call:${request.callId}:request`);
    expect(request.expiresAt.toISOString()).toBe("2026-10-14T18:30:45.000Z");
    expect(request.blocks).toEqual([
      expect.objectContaining({
        kind: "call_request",
        reason: "Send the report",
        status: "ringing",
      }),
    ]);
    expect(newCallRequest({ reason: "", opening: "Hi" })).toEqual({ error: "reason is required." });
  });
});

describe("settleCallRequest", () => {
  it("moves a ringing call on and tells the thread", async () => {
    const prisma = prismaWith({});
    const events = { append: vi.fn(async () => ({}) as never) };
    const settled = await settleCallRequest(
      { prisma, events },
      { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "answered" },
    );

    expect(settled).toMatchObject({ status: "answered", opening: "Hi, it's about the report." });
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.message.updated",
        botId: "bot-1",
        payload: expect.objectContaining({ messageId: "message-1", callId: "call-1" }),
      }),
    );
  });

  it("leaves a call that already moved on alone", async () => {
    const events = { append: vi.fn() };
    await expect(
      settleCallRequest(
        { prisma: prismaWith({ status: "missed" }), events },
        { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "answered" },
      ),
    ).resolves.toBeNull();
    expect(events.append).not.toHaveBeenCalled();
  });

  it("settles once when two devices race", async () => {
    const events = { append: vi.fn() };
    await expect(
      settleCallRequest(
        { prisma: prismaWith({ updated: 0 }), events },
        { threadId: "thread-1", callId: "call-1", from: ["ringing"], status: "answered" },
      ),
    ).resolves.toBeNull();
    expect(events.append).not.toHaveBeenCalled();
  });

  it("records how long an answered call lasted", async () => {
    const prisma = prismaWith({ status: "answered" });
    await settleCallRequest(
      { prisma, events: { append: vi.fn(async () => ({}) as never) } },
      { threadId: "thread-1", callId: "call-1", from: ["answered"], durationSeconds: 42 },
    );
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { blocks: [expect.objectContaining({ status: "answered", durationSeconds: 42 })] },
      }),
    );
  });
});
