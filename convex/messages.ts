import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "😮", "😢"];

export const list = query({
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

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversationId_createdAt", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();

    return await Promise.all(
      messages.map(async (message) => {
        const sender = await ctx.db.get(message.senderId);
        const reactions = await ctx.db
          .query("messageReactions")
          .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
          .collect();

        const reactionCounts = ALLOWED_REACTIONS.map((emoji) => ({
          emoji,
          count: reactions.filter((reaction) => reaction.emoji === emoji).length,
          reactedByMe: reactions.some(
            (reaction) => reaction.emoji === emoji && reaction.userId === me._id,
          ),
        })).filter((reaction) => reaction.count > 0);

        return {
          _id: message._id,
          body: message.body,
          deleted: !!message.deleted,
          createdAt: message.createdAt,
          senderName: sender?.name ?? "Unknown",
          isOwn: message.senderId === me._id,
          reactionCounts,
        };
      }),
    );
  },
});

export const send = mutation({
  args: {
    conversationId: v.id("conversations"),
    body: v.string(),
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

    const body = args.body.trim();
    if (!body) {
      throw new Error("Message cannot be empty");
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      senderId: me._id,
      body,
      createdAt: now,
    });

    await ctx.db.patch(args.conversationId, {
      updatedAt: now,
      lastMessageText: body,
      lastMessageAt: now,
    });

    await ctx.db.patch(membership._id, {
      lastReadAt: now,
    });

    const typing = await ctx.db
      .query("typingStatus")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (typing) {
      await ctx.db.delete(typing._id);
    }

    return messageId;
  },
});

export const deleteOwnMessage = mutation({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const message = await ctx.db.get(args.messageId);

    if (!message) {
      throw new Error("Message not found");
    }

    if (message.senderId !== me._id) {
      throw new Error("Forbidden");
    }

    await ctx.db.patch(args.messageId, {
      deleted: true,
      body: "",
    });
  },
});

export const toggleReaction = mutation({
  args: {
    messageId: v.id("messages"),
    emoji: v.string(),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);

    if (!ALLOWED_REACTIONS.includes(args.emoji)) {
      throw new Error("Invalid reaction");
    }

    const message = await ctx.db.get(args.messageId);
    if (!message) {
      throw new Error("Message not found");
    }

    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", message.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!membership) {
      throw new Error("Not found");
    }

    const existing = await ctx.db
      .query("messageReactions")
      .withIndex("by_messageId_userId_emoji", (q) =>
        q.eq("messageId", args.messageId).eq("userId", me._id).eq("emoji", args.emoji),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { reacted: false };
    }

    await ctx.db.insert("messageReactions", {
      messageId: args.messageId,
      userId: me._id,
      emoji: args.emoji,
      createdAt: Date.now(),
    });

    return { reacted: true };
  },
});
