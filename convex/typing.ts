import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

export const updateTyping = mutation({
  args: {
    conversationId: v.id("conversations"),
    isTyping: v.boolean(),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);

    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!membership) {
      throw new Error("Not found");
    }

    const existing = await ctx.db
      .query("typingStatus")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!args.isTyping) {
      if (existing) {
        await ctx.db.delete(existing._id);
      }
      return null;
    }

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("typingStatus", {
      conversationId: args.conversationId,
      userId: me._id,
      updatedAt: now,
    });
  },
});

export const listTypingUsers = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);

    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!membership) {
      throw new Error("Not found");
    }

    const activeThreshold = Date.now() - 2_000;
    const statuses = await ctx.db
      .query("typingStatus")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    const active = statuses.filter(
      (status) => status.userId !== me._id && status.updatedAt >= activeThreshold,
    );

    return await Promise.all(
      active.map(async (status) => {
        const user = await ctx.db.get(status.userId);
        return {
          userId: status.userId,
          name: user?.name ?? "Someone",
        };
      }),
    );
  },
});
