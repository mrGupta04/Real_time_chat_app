import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

export const listForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!me) {
      return [];
    }

    const memberships = await ctx.db
      .query("conversationMembers")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .collect();

    const rows = await Promise.all(
      memberships.map(async (membership) => {
        const conversation = await ctx.db.get(membership.conversationId);
        if (!conversation) {
          return null;
        }

        const members = await ctx.db
          .query("conversationMembers")
          .withIndex("by_conversationId", (q) =>
            q.eq("conversationId", conversation._id),
          )
          .collect();

        const otherMember = members.find((member) => member.userId !== me._id);
        const otherUser = otherMember ? await ctx.db.get(otherMember.userId) : null;

        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversationId_createdAt", (q) =>
            q.eq("conversationId", conversation._id),
          )
          .collect();

        const unreadCount = messages.filter(
          (message) =>
            message.senderId !== me._id &&
            message.createdAt > (membership.lastReadAt ?? 0),
        ).length;

        return {
          _id: conversation._id,
          updatedAt: conversation.updatedAt,
          isGroup: conversation.isGroup,
          memberCount: members.length,
          unreadCount,
          title:
            conversation.isGroup && conversation.name
              ? conversation.name
              : otherUser?.name ?? "Unknown user",
          imageUrl: otherUser?.imageUrl,
          lastMessageText: conversation.lastMessageText,
          lastMessageAt: conversation.lastMessageAt,
        };
      }),
    );

    return rows
      .filter((row) => row !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const getOrCreateDirectConversation = mutation({
  args: {
    otherUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    if (me._id === args.otherUserId) {
      throw new Error("Cannot message yourself");
    }

    const myMemberships = await ctx.db
      .query("conversationMembers")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .collect();

    for (const membership of myMemberships) {
      const members = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", membership.conversationId),
        )
        .collect();

      const conversation = await ctx.db.get(membership.conversationId);
      if (!conversation || conversation.isGroup) {
        continue;
      }

      if (members.length !== 2) {
        continue;
      }

      const includesOther = members.some(
        (member) => member.userId === args.otherUserId,
      );

      if (includesOther) {
        return membership.conversationId;
      }
    }

    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      isGroup: false,
      createdBy: me._id,
      updatedAt: now,
    });

    await ctx.db.insert("conversationMembers", {
      conversationId,
      userId: me._id,
      joinedAt: now,
      lastReadAt: now,
    });

    await ctx.db.insert("conversationMembers", {
      conversationId,
      userId: args.otherUserId,
      joinedAt: now,
    });

    return conversationId;
  },
});

export const getConversation = query({
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

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      throw new Error("Not found");
    }

    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    const otherMember = members.find((member) => member.userId !== me._id);
    const otherUser = otherMember ? await ctx.db.get(otherMember.userId) : null;

    return {
      _id: conversation._id,
      isGroup: conversation.isGroup,
      memberCount: members.length,
      title:
        conversation.isGroup && conversation.name
          ? conversation.name
          : otherUser?.name ?? "Unknown user",
      imageUrl: otherUser?.imageUrl,
    };
  },
});

export const markAsRead = mutation({
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

    await ctx.db.patch(membership._id, {
      lastReadAt: Date.now(),
    });
  },
});

export const createGroupConversation = mutation({
  args: {
    name: v.string(),
    memberIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const trimmedName = args.name.trim();
    if (!trimmedName) {
      throw new Error("Group name is required");
    }

    const uniqueMembers = Array.from(new Set(args.memberIds));
    const filtered = uniqueMembers.filter((id) => id !== me._id);
    if (filtered.length < 2) {
      throw new Error("Select at least 2 other users");
    }

    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      isGroup: true,
      name: trimmedName,
      createdBy: me._id,
      updatedAt: now,
    });

    await ctx.db.insert("conversationMembers", {
      conversationId,
      userId: me._id,
      joinedAt: now,
      lastReadAt: now,
    });

    for (const memberId of filtered) {
      await ctx.db.insert("conversationMembers", {
        conversationId,
        userId: memberId,
        joinedAt: now,
      });
    }

    return conversationId;
  },
});
