import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  }).index("by_clerkId", ["clerkId"]),

  userPresence: defineTable({
    userId: v.id("users"),
    lastSeenAt: v.number(),
  }).index("by_userId", ["userId"]),

  conversations: defineTable({
    isGroup: v.boolean(),
    name: v.optional(v.string()),
    createdBy: v.id("users"),
    updatedAt: v.number(),
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()),
  }).index("by_updatedAt", ["updatedAt"]),

  conversationMembers: defineTable({
    conversationId: v.id("conversations"),
    userId: v.id("users"),
    joinedAt: v.number(),
    role: v.optional(v.union(v.literal("owner"), v.literal("admin"), v.literal("member"))),
    lastReadAt: v.optional(v.number()),
    clearedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
  })
    .index("by_userId", ["userId"])
    .index("by_conversationId", ["conversationId"])
    .index("by_conversationId_userId", ["conversationId", "userId"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    body: v.string(),
    replyToMessageId: v.optional(v.id("messages")),
    mediaType: v.optional(
      v.union(v.literal("image"), v.literal("video"), v.literal("audio")),
    ),
    mediaStorageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
    deleted: v.optional(v.boolean()),
  }).index("by_conversationId_createdAt", ["conversationId", "createdAt"]),

  typingStatus: defineTable({
    conversationId: v.id("conversations"),
    userId: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_conversationId_userId", ["conversationId", "userId"]),

  messageReactions: defineTable({
    messageId: v.id("messages"),
    userId: v.id("users"),
    emoji: v.string(),
    createdAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_messageId_userId_emoji", ["messageId", "userId", "emoji"]),

  messageStars: defineTable({
    messageId: v.id("messages"),
    userId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_userId", ["userId"])
    .index("by_messageId_userId", ["messageId", "userId"]),

  messageEdits: defineTable({
    messageId: v.id("messages"),
    editorId: v.id("users"),
    previousBody: v.string(),
    editedAt: v.number(),
  }).index("by_messageId", ["messageId"]),

  blocks: defineTable({
    blockerId: v.id("users"),
    blockedId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_blockerId", ["blockerId"])
    .index("by_blockedId", ["blockedId"])
    .index("by_blockerId_blockedId", ["blockerId", "blockedId"]),

  privacySettings: defineTable({
    userId: v.id("users"),
    readReceiptsEnabled: v.boolean(),
    lastSeenVisibility: v.union(v.literal("everyone"), v.literal("nobody")),
    whoCanMessage: v.union(v.literal("everyone"), v.literal("nobody")),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  securitySettings: defineTable({
    userId: v.id("users"),
    suspiciousLoginAlerts: v.boolean(),
    e2eeEnabled: v.boolean(),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  deviceSessions: defineTable({
    userId: v.id("users"),
    deviceName: v.string(),
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    isActive: v.boolean(),
  }).index("by_userId", ["userId"]),
});
