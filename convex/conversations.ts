import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";
import { isBlockedBetween } from "./lib/blocks";
import { canMessageUser } from "./lib/privacy";

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
        if (membership.isDeleted) {
          return null;
        }

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

        const activeMembers = members.filter((member) => !member.isDeleted);
        const otherMember = activeMembers.find((member) => member.userId !== me._id);
        const otherUser = otherMember ? await ctx.db.get(otherMember.userId) : null;

        if (!conversation.isGroup && otherUser) {
          const blocked = await isBlockedBetween(ctx, me._id, otherUser._id);
          if (blocked) {
            return null;
          }
        }

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
          memberCount: activeMembers.length,
          myRole: membership.role ?? "member",
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

    const blocked = await isBlockedBetween(ctx, me._id, args.otherUserId);
    if (blocked) {
      throw new Error("Cannot message this user");
    }

    const allowed = await canMessageUser(ctx, me._id, args.otherUserId);
    if (!allowed) {
      throw new Error("Messaging disabled by privacy settings");
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
        if (membership.isDeleted) {
          await ctx.db.patch(membership._id, {
            isDeleted: false,
            lastReadAt: Date.now(),
          });
        }
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
      role: "member",
      lastReadAt: now,
    });

    await ctx.db.insert("conversationMembers", {
      conversationId,
      userId: args.otherUserId,
      joinedAt: now,
      role: "member",
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

    if (!membership || membership.isDeleted) {
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

    const activeMembers = members.filter((member) => !member.isDeleted);
    const otherMember = activeMembers.find((member) => member.userId !== me._id);
    const otherUser = otherMember ? await ctx.db.get(otherMember.userId) : null;

    if (!conversation.isGroup && otherUser) {
      const blocked = await isBlockedBetween(ctx, me._id, otherUser._id);
      if (blocked) {
        throw new Error("Not found");
      }
    }

    return {
      _id: conversation._id,
      isGroup: conversation.isGroup,
      memberCount: activeMembers.length,
      myRole: membership.role ?? "member",
      title:
        conversation.isGroup && conversation.name
          ? conversation.name
          : otherUser?.name ?? "Unknown user",
      imageUrl: otherUser?.imageUrl,
      otherUserId: otherUser?._id,
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

    if (!membership || membership.isDeleted) {
      throw new Error("Not found");
    }

    await ctx.db.patch(membership._id, {
      lastReadAt: Date.now(),
    });
  },
});

export const deleteConversationForMe = mutation({
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

    if (membership.isDeleted) {
      return { deleted: true };
    }

    await ctx.db.patch(membership._id, {
      isDeleted: true,
      lastReadAt: Date.now(),
    });

    const typingRows = await ctx.db
      .query("typingStatus")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .collect();

    for (const typing of typingRows) {
      await ctx.db.delete(typing._id);
    }

    return { deleted: true };
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
      role: "owner",
      lastReadAt: now,
    });

    for (const memberId of filtered) {
      await ctx.db.insert("conversationMembers", {
        conversationId,
        userId: memberId,
        joinedAt: now,
        role: "member",
      });
    }

    return conversationId;
  },
});

export const listGroupMembers = query({
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

    if (!membership || membership.isDeleted) {
      throw new Error("Not found");
    }

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || !conversation.isGroup) {
      throw new Error("Not found");
    }

    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    return await Promise.all(
      members
        .filter((member) => !member.isDeleted)
        .map(async (member) => {
          const user = await ctx.db.get(member.userId);
          return {
            membershipId: member._id,
            userId: member.userId,
            name: user?.name ?? "Unknown",
            imageUrl: user?.imageUrl,
            role: member.role ?? "member",
          };
        }),
    );
  },
});

export const addGroupMembers = mutation({
  args: {
    conversationId: v.id("conversations"),
    memberIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const myMembership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!myMembership || myMembership.isDeleted) {
      throw new Error("Not found");
    }

    if (!["owner", "admin"].includes(myMembership.role ?? "member")) {
      throw new Error("Forbidden");
    }

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || !conversation.isGroup) {
      throw new Error("Not found");
    }

    const now = Date.now();
    const unique = Array.from(new Set(args.memberIds)).filter((id) => id !== me._id);

    for (const memberId of unique) {
      const existing = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversationId_userId", (q) =>
          q.eq("conversationId", args.conversationId).eq("userId", memberId),
        )
        .unique();

      if (existing) {
        if (existing.isDeleted) {
          await ctx.db.patch(existing._id, {
            isDeleted: false,
            joinedAt: now,
            role: existing.role ?? "member",
          });
        }
        continue;
      }

      await ctx.db.insert("conversationMembers", {
        conversationId: args.conversationId,
        userId: memberId,
        joinedAt: now,
        role: "member",
      });
    }

    return { added: true };
  },
});

export const removeGroupMember = mutation({
  args: {
    conversationId: v.id("conversations"),
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const myMembership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!myMembership || myMembership.isDeleted) {
      throw new Error("Not found");
    }

    const targetMembership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", args.targetUserId),
      )
      .unique();

    if (!targetMembership || targetMembership.isDeleted) {
      throw new Error("Not found");
    }

    const myRole = myMembership.role ?? "member";
    const targetRole = targetMembership.role ?? "member";

    if (myRole === "member") {
      throw new Error("Forbidden");
    }

    if (myRole === "admin" && targetRole !== "member") {
      throw new Error("Forbidden");
    }

    await ctx.db.patch(targetMembership._id, {
      isDeleted: true,
      lastReadAt: Date.now(),
    });

    return { removed: true };
  },
});

export const updateGroupMemberRole = mutation({
  args: {
    conversationId: v.id("conversations"),
    targetUserId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const myMembership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!myMembership || myMembership.isDeleted || (myMembership.role ?? "member") !== "owner") {
      throw new Error("Forbidden");
    }

    const targetMembership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", args.targetUserId),
      )
      .unique();

    if (!targetMembership || targetMembership.isDeleted) {
      throw new Error("Not found");
    }

    if ((targetMembership.role ?? "member") === "owner") {
      throw new Error("Cannot change owner role");
    }

    await ctx.db.patch(targetMembership._id, {
      role: args.role,
    });

    return { updated: true };
  },
});
