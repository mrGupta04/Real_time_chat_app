import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";
import { isBlockedBetween } from "./lib/blocks";
import { resolveUserDisplayName } from "./lib/displayName";
import { canMessageUser, getOrCreatePrivacySettings } from "./lib/privacy";

const ALLOWED_REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🔥",
  "🎉",
  "🙏",
  "👀",
  "😍",
  "😎",
  "🤔",
];

export const list = query({
  args: {
    conversationId: v.id("conversations"),
    beforeCreatedAt: v.optional(v.number()),
    limit: v.optional(v.number()),
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

    if (!conversation.isGroup) {
      const members = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
        .collect();
      const otherMember = members.find((member) => member.userId !== me._id);

      if (otherMember) {
        const blocked = await isBlockedBetween(ctx, me._id, otherMember.userId);
        if (blocked) {
          throw new Error("Not found");
        }
      }
    }

    const takeCount = Math.min(Math.max(args.limit ?? 40, 1), 100);

    const messages = args.beforeCreatedAt
      ? await ctx.db
          .query("messages")
          .withIndex("by_conversationId_createdAt", (q) =>
            q.eq("conversationId", args.conversationId).lt("createdAt", args.beforeCreatedAt!),
          )
          .order("desc")
          .take(takeCount)
      : await ctx.db
          .query("messages")
          .withIndex("by_conversationId_createdAt", (q) =>
            q.eq("conversationId", args.conversationId),
          )
          .order("desc")
          .take(takeCount);

    const orderedMessages = [...messages].reverse();

    const items = await Promise.all(
      orderedMessages.map(async (message) => {
        const sender = await ctx.db.get(message.senderId);
        const reactions = await ctx.db
          .query("messageReactions")
          .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
          .collect();
        const edits = await ctx.db
          .query("messageEdits")
          .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
          .collect();
        const star = await ctx.db
          .query("messageStars")
          .withIndex("by_messageId_userId", (q) =>
            q.eq("messageId", message._id).eq("userId", me._id),
          )
          .unique();
        const replyToMessage = message.replyToMessageId
          ? await ctx.db.get(message.replyToMessageId)
          : null;
        const replyToSender = replyToMessage
          ? await ctx.db.get(replyToMessage.senderId)
          : null;

        const reactionCounts = ALLOWED_REACTIONS.map((emoji) => ({
          emoji,
          count: reactions.filter((reaction) => reaction.emoji === emoji).length,
          reactedByMe: reactions.some(
            (reaction) => reaction.emoji === emoji && reaction.userId === me._id,
          ),
        })).filter((reaction) => reaction.count > 0);

        const members = await ctx.db
          .query("conversationMembers")
          .withIndex("by_conversationId", (q) => q.eq("conversationId", message.conversationId))
          .collect();

        const seenBy = await Promise.all(
          members
            .filter((member) => !member.isDeleted && member.userId !== message.senderId)
            .map(async (member) => {
              const privacy = await getOrCreatePrivacySettings(ctx, member.userId);
              if (!privacy.readReceiptsEnabled) {
                return null;
              }
              if ((member.lastReadAt ?? 0) < message.createdAt) {
                return null;
              }
              const user = await ctx.db.get(member.userId);
              return {
                userId: member.userId,
                name: resolveUserDisplayName(user),
              };
            }),
        );

        const visibleSeenBy = seenBy.filter(
          (row): row is NonNullable<typeof row> => row !== null,
        );

        const isOwn = message.senderId === me._id;
        const recipientMembers = members.filter(
          (member) => !member.isDeleted && member.userId !== message.senderId,
        );
        const isDelivered = recipientMembers.length > 0;
        const status = !isOwn
          ? null
          : visibleSeenBy.length > 0
            ? "read"
            : isDelivered
              ? "delivered"
              : "sent";

        return {
          _id: message._id,
          body: message.body,
          deleted: !!message.deleted,
          createdAt: message.createdAt,
          editedAt: edits.length > 0 ? edits[edits.length - 1].editedAt : null,
          editCount: edits.length,
          isStarred: !!star,
          status,
          seenBy: visibleSeenBy,
          mediaType: message.mediaType,
          mediaUrl: message.mediaStorageId
            ? await ctx.storage.getUrl(message.mediaStorageId)
            : null,
          replyTo: message.replyToMessageId
            ? replyToMessage
              ? {
                  messageId: replyToMessage._id,
                  senderName: resolveUserDisplayName(replyToSender),
                  body: replyToMessage.deleted
                    ? "This message was deleted"
                    : replyToMessage.body,
                  mediaType: replyToMessage.mediaType,
                }
              : {
                  messageId: message.replyToMessageId,
                  senderName: "User",
                  body: "Original message unavailable",
                  mediaType: undefined,
                }
            : null,
          senderName: resolveUserDisplayName(sender),
          senderImageUrl: sender?.imageUrl,
          isOwn,
          reactionCounts,
        };
      }),
    );

    const oldestCreatedAt = orderedMessages[0]?.createdAt ?? null;
    const hasMore =
      oldestCreatedAt !== null
        ? (
            await ctx.db
              .query("messages")
              .withIndex("by_conversationId_createdAt", (q) =>
                q.eq("conversationId", args.conversationId).lt("createdAt", oldestCreatedAt),
              )
              .first()
          ) !== null
        : false;

    return {
      items,
      oldestCreatedAt,
      hasMore,
    };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await getCurrentUserOrThrow(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const send = mutation({
  args: {
    conversationId: v.id("conversations"),
    body: v.string(),
    replyToMessageId: v.optional(v.id("messages")),
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

    if (!conversation.isGroup) {
      const members = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
        .collect();
      const otherMember = members.find((member) => member.userId !== me._id);

      if (otherMember) {
        const blocked = await isBlockedBetween(ctx, me._id, otherMember.userId);
        if (blocked) {
          throw new Error("Cannot send message");
        }

        const allowed = await canMessageUser(ctx, me._id, otherMember.userId);
        if (!allowed) {
          throw new Error("Messaging disabled by privacy settings");
        }
      }
    }

    const body = args.body.trim();
    if (!body) {
      throw new Error("Message cannot be empty");
    }

    let replySnippet = "";
    if (args.replyToMessageId) {
      const replyTarget = await ctx.db.get(args.replyToMessageId);
      if (!replyTarget || replyTarget.conversationId !== args.conversationId) {
        throw new Error("Invalid reply target");
      }
      replySnippet = replyTarget.deleted
        ? "Reply"
        : replyTarget.body.trim().slice(0, 30) || "Reply";
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      senderId: me._id,
      body,
      replyToMessageId: args.replyToMessageId,
      createdAt: now,
    });

    await ctx.db.patch(args.conversationId, {
      updatedAt: now,
      lastMessageText: args.replyToMessageId ? `↩️ ${replySnippet}: ${body}` : body,
      lastMessageAt: now,
    });

    await ctx.db.patch(membership._id, {
      lastReadAt: now,
    });

    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    await Promise.all(
      members
        .filter((member) => member.userId !== me._id && member.isDeleted)
        .map((member) => ctx.db.patch(member._id, { isDeleted: false })),
    );

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

export const sendMedia = mutation({
  args: {
    conversationId: v.id("conversations"),
    storageId: v.id("_storage"),
    mediaType: v.union(v.literal("image"), v.literal("video"), v.literal("audio")),
    caption: v.optional(v.string()),
    replyToMessageId: v.optional(v.id("messages")),
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

    if (!conversation.isGroup) {
      const members = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
        .collect();
      const otherMember = members.find((member) => member.userId !== me._id);

      if (otherMember) {
        const blocked = await isBlockedBetween(ctx, me._id, otherMember.userId);
        if (blocked) {
          throw new Error("Cannot send message");
        }

        const allowed = await canMessageUser(ctx, me._id, otherMember.userId);
        if (!allowed) {
          throw new Error("Messaging disabled by privacy settings");
        }
      }
    }

    const now = Date.now();
    const caption = args.caption?.trim() ?? "";
    if (args.replyToMessageId) {
      const replyTarget = await ctx.db.get(args.replyToMessageId);
      if (!replyTarget || replyTarget.conversationId !== args.conversationId) {
        throw new Error("Invalid reply target");
      }
    }

    await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      senderId: me._id,
      body: caption,
      replyToMessageId: args.replyToMessageId,
      mediaType: args.mediaType,
      mediaStorageId: args.storageId,
      createdAt: now,
    });

    const lastMessageText =
      args.mediaType === "image"
        ? caption
          ? `📷 ${caption}`
          : "📷 Photo"
        : args.mediaType === "video"
          ? caption
            ? `🎬 ${caption}`
            : "🎬 Video"
          : caption
            ? `🎤 ${caption}`
            : "🎤 Voice note";

    await ctx.db.patch(args.conversationId, {
      updatedAt: now,
      lastMessageText,
      lastMessageAt: now,
    });

    await ctx.db.patch(membership._id, {
      lastReadAt: now,
    });

    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    await Promise.all(
      members
        .filter((member) => member.userId !== me._id && member.isDeleted)
        .map((member) => ctx.db.patch(member._id, { isDeleted: false })),
    );

    const typing = await ctx.db
      .query("typingStatus")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me._id),
      )
      .unique();

    if (typing) {
      await ctx.db.delete(typing._id);
    }

    return { sent: true };
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

    if (!membership || membership.isDeleted) {
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

export const editOwnMessage = mutation({
  args: {
    messageId: v.id("messages"),
    body: v.string(),
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

    if (message.deleted) {
      throw new Error("Cannot edit deleted message");
    }

    const nextBody = args.body.trim();
    if (!nextBody) {
      throw new Error("Message cannot be empty");
    }

    await ctx.db.insert("messageEdits", {
      messageId: message._id,
      editorId: me._id,
      previousBody: message.body,
      editedAt: Date.now(),
    });

    await ctx.db.patch(message._id, {
      body: nextBody,
    });

    return { edited: true };
  },
});

export const getEditHistory = query({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      throw new Error("Not found");
    }

    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversationId_userId", (q) =>
        q.eq("conversationId", message.conversationId).eq("userId", me._id),
      )
      .unique();

    if (!membership || membership.isDeleted) {
      throw new Error("Not found");
    }

    const edits = await ctx.db
      .query("messageEdits")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .collect();

    return edits.sort((a, b) => b.editedAt - a.editedAt);
  },
});

export const toggleStar = mutation({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
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

    if (!membership || membership.isDeleted) {
      throw new Error("Not found");
    }

    const existing = await ctx.db
      .query("messageStars")
      .withIndex("by_messageId_userId", (q) =>
        q.eq("messageId", args.messageId).eq("userId", me._id),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { starred: false };
    }

    await ctx.db.insert("messageStars", {
      messageId: args.messageId,
      userId: me._id,
      createdAt: Date.now(),
    });

    return { starred: true };
  },
});

export const listStarred = query({
  args: {
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const stars = await ctx.db
      .query("messageStars")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .collect();

    const rows = await Promise.all(
      stars.map(async (star) => {
        const message = await ctx.db.get(star.messageId);
        if (!message) {
          return null;
        }

        if (args.conversationId && message.conversationId !== args.conversationId) {
          return null;
        }

        const membership = await ctx.db
          .query("conversationMembers")
          .withIndex("by_conversationId_userId", (q) =>
            q.eq("conversationId", message.conversationId).eq("userId", me._id),
          )
          .unique();

        if (!membership || membership.isDeleted) {
          return null;
        }

        return {
          messageId: message._id,
          conversationId: message.conversationId,
          body: message.body,
          mediaType: message.mediaType,
          createdAt: message.createdAt,
          starredAt: star.createdAt,
        };
      }),
    );

    return rows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.starredAt - a.starredAt);
  },
});

export const searchInConversation = query({
  args: {
    conversationId: v.id("conversations"),
    text: v.optional(v.string()),
    mediaType: v.optional(
      v.union(v.literal("image"), v.literal("video"), v.literal("audio")),
    ),
    senderId: v.optional(v.id("users")),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
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

    const text = args.text?.trim().toLowerCase();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversationId_createdAt", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    return messages
      .filter((message) => !message.deleted)
      .filter((message) => (text ? message.body.toLowerCase().includes(text) : true))
      .filter((message) => (args.mediaType ? message.mediaType === args.mediaType : true))
      .filter((message) => (args.senderId ? message.senderId === args.senderId : true))
      .filter((message) => (args.fromDate ? message.createdAt >= args.fromDate : true))
      .filter((message) => (args.toDate ? message.createdAt <= args.toDate : true))
      .map((message) => ({
        messageId: message._id,
        conversationId: message.conversationId,
        body: message.body,
        mediaType: message.mediaType,
        createdAt: message.createdAt,
      }));
  },
});

export const searchGlobal = query({
  args: {
    text: v.optional(v.string()),
    mediaType: v.optional(
      v.union(v.literal("image"), v.literal("video"), v.literal("audio")),
    ),
    senderId: v.optional(v.id("users")),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const memberships = await ctx.db
      .query("conversationMembers")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .collect();

    const conversationIds = memberships
      .filter((membership) => !membership.isDeleted)
      .map((membership) => membership.conversationId);

    const results = await Promise.all(
      conversationIds.map(async (conversationId) => {
        const conversation = await ctx.db.get(conversationId);
        const rows = await ctx.db
          .query("messages")
          .withIndex("by_conversationId_createdAt", (q) => q.eq("conversationId", conversationId))
          .collect();

        const text = args.text?.trim().toLowerCase();

        return rows
          .filter((message) => !message.deleted)
          .filter((message) => (text ? message.body.toLowerCase().includes(text) : true))
          .filter((message) => (args.mediaType ? message.mediaType === args.mediaType : true))
          .filter((message) => (args.senderId ? message.senderId === args.senderId : true))
          .filter((message) => (args.fromDate ? message.createdAt >= args.fromDate : true))
          .filter((message) => (args.toDate ? message.createdAt <= args.toDate : true))
          .map((message) => ({
            messageId: message._id,
            conversationId,
            conversationTitle: conversation?.name ?? "Direct chat",
            body: message.body,
            mediaType: message.mediaType,
            createdAt: message.createdAt,
          }));
      }),
    );

    return results.flat().sort((a, b) => b.createdAt - a.createdAt);
  },
});
