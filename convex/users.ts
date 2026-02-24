import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const upsertCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const name =
      identity.name ??
      identity.givenName ??
      identity.nickname ??
      identity.email?.split("@")[0] ??
      "Anonymous";

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name,
        email: identity.email,
        imageUrl: identity.pictureUrl,
      });
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkId: identity.subject,
      name,
      email: identity.email,
      imageUrl: identity.pictureUrl,
    });
  },
});

export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    return await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
  },
});

export const listUsers = query({
  args: {
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const self = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!self) {
      return [];
    }

    const search = args.search?.trim().toLowerCase();
    const onlineThreshold = Date.now() - 30_000;
    const users = await ctx.db.query("users").collect();

    const rows = await Promise.all(
      users.map(async (user) => {
        const presence = await ctx.db
          .query("userPresence")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .unique();

        return {
          ...user,
          isOnline: !!presence && presence.lastSeenAt >= onlineThreshold,
        };
      }),
    );

    return rows
      .filter((user) => user._id !== self._id)
      .filter((user) => {
        if (!search) {
          return true;
        }
        return user.name.toLowerCase().includes(search);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
