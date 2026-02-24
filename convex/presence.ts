import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }

    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!me) {
      return null;
    }

    const now = Date.now();

    const existing = await ctx.db
      .query("userPresence")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
      return existing._id;
    }

    return await ctx.db.insert("userPresence", {
      userId: me._id,
      lastSeenAt: now,
    });
  },
});

export const onlineUsers = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUserOrThrow(ctx);
    const onlineThreshold = Date.now() - 30_000;

    const all = await ctx.db.query("userPresence").collect();

    return all
      .filter((row) => row.lastSeenAt >= onlineThreshold)
      .map((row) => row.userId)
      .filter((id) => id !== me._id);
  },
});
