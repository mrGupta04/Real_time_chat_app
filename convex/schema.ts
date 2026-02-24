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
    lastReadAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_conversationId", ["conversationId"])
    .index("by_conversationId_userId", ["conversationId", "userId"]),

  messages: defineTable({
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    body: v.string(),
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
});
