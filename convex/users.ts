import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";
import { getOrCreatePrivacySettings } from "./lib/privacy";

export const upsertCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }

    const fullName = [identity.givenName, identity.familyName]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(" ");

    const name =
      identity.name ??
      (fullName.length > 0 ? fullName : undefined) ??
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
    const me = await getCurrentUser(ctx);

    if (!me) {
      return [];
    }

    const search = args.search?.trim().toLowerCase();
    const onlineThreshold = Date.now() - 30_000;
    const users = await ctx.db.query("users").collect();

    const rows = await Promise.all(
      users.map(async (user) => {
        const blockedByMe = await ctx.db
          .query("blocks")
          .withIndex("by_blockerId_blockedId", (q) =>
            q.eq("blockerId", me._id).eq("blockedId", user._id),
          )
          .unique();

        const blockedMe = await ctx.db
          .query("blocks")
          .withIndex("by_blockerId_blockedId", (q) =>
            q.eq("blockerId", user._id).eq("blockedId", me._id),
          )
          .unique();

        const privacy = await getOrCreatePrivacySettings(ctx, user._id);
        const presence = await ctx.db
          .query("userPresence")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .unique();

        return {
          ...user,
          isOnline:
            privacy.lastSeenVisibility === "everyone" &&
            !!presence &&
            presence.lastSeenAt >= onlineThreshold,
          canBeMessaged: privacy.whoCanMessage === "everyone",
          isBlockedByMe: !!blockedByMe,
          hasBlockedMe: !!blockedMe,
        };
      }),
    );

    return rows
      .filter((user) => user._id !== me._id)
      .filter((user) => !user.isBlockedByMe && !user.hasBlockedMe)
      .filter((user) => user.canBeMessaged)
      .filter((user) => {
        if (!search) {
          return true;
        }
        return (
          user.name.toLowerCase().includes(search) ||
          user.email?.toLowerCase().includes(search)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const listBlockedUsers = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) {
      return [];
    }

    let blockedRows: Array<{ blockedId: typeof me._id }> = [];
    try {
      blockedRows = await ctx.db
        .query("blocks")
        .withIndex("by_blockerId", (q) => q.eq("blockerId", me._id))
        .collect();
    } catch {
      try {
        const allBlocks = await ctx.db.query("blocks").collect();
        blockedRows = allBlocks.filter((row) => row.blockerId === me._id);
      } catch {
        return [];
      }
    }

    const users = await Promise.all(
      blockedRows.map(async (row) => {
        const user = await ctx.db.get(row.blockedId);
        if (!user) {
          return null;
        }

        const safeName =
          typeof user.name === "string" && user.name.trim().length > 0
            ? user.name
            : user.email?.trim() || "Unknown user";

        return {
          _id: user._id,
          name: safeName,
          imageUrl: user.imageUrl,
        };
      }),
    );

    return users
      .filter((user): user is NonNullable<typeof user> => user !== null)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  },
});

export const toggleBlockUser = mutation({
  args: {
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);

    if (args.targetUserId === me._id) {
      throw new Error("Cannot block yourself");
    }

    const target = await ctx.db.get(args.targetUserId);
    if (!target) {
      throw new Error("User not found");
    }

    const existing = await ctx.db
      .query("blocks")
      .withIndex("by_blockerId_blockedId", (q) =>
        q.eq("blockerId", me._id).eq("blockedId", args.targetUserId),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { blocked: false };
    }

    await ctx.db.insert("blocks", {
      blockerId: me._id,
      blockedId: args.targetUserId,
      createdAt: Date.now(),
    });

    return { blocked: true };
  },
});

export const getMyPrivacySettings = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUserOrThrow(ctx);
    const current = await getOrCreatePrivacySettings(ctx, me._id);
    return {
      readReceiptsEnabled: current.readReceiptsEnabled,
      lastSeenVisibility: current.lastSeenVisibility,
      whoCanMessage: current.whoCanMessage,
    };
  },
});

export const updateMyPrivacySettings = mutation({
  args: {
    readReceiptsEnabled: v.optional(v.boolean()),
    lastSeenVisibility: v.optional(v.union(v.literal("everyone"), v.literal("nobody"))),
    whoCanMessage: v.optional(v.union(v.literal("everyone"), v.literal("nobody"))),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const existing = await ctx.db
      .query("privacySettings")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .unique();

    const current = await getOrCreatePrivacySettings(ctx, me._id);

    if (existing) {
      await ctx.db.patch(existing._id, {
        readReceiptsEnabled: args.readReceiptsEnabled ?? current.readReceiptsEnabled,
        lastSeenVisibility: args.lastSeenVisibility ?? current.lastSeenVisibility,
        whoCanMessage: args.whoCanMessage ?? current.whoCanMessage,
        updatedAt: Date.now(),
      });
      return { updated: true };
    }

    await ctx.db.insert("privacySettings", {
      userId: me._id,
      readReceiptsEnabled: args.readReceiptsEnabled ?? current.readReceiptsEnabled,
      lastSeenVisibility: args.lastSeenVisibility ?? current.lastSeenVisibility,
      whoCanMessage: args.whoCanMessage ?? current.whoCanMessage,
      updatedAt: Date.now(),
    });

    return { updated: true };
  },
});

export const getMySecuritySettings = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUserOrThrow(ctx);
    const existing = await ctx.db
      .query("securitySettings")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .unique();

    if (existing) {
      return {
        suspiciousLoginAlerts: existing.suspiciousLoginAlerts,
        e2eeEnabled: existing.e2eeEnabled,
      };
    }

    return {
      suspiciousLoginAlerts: true,
      e2eeEnabled: false,
    };
  },
});

export const updateMySecuritySettings = mutation({
  args: {
    suspiciousLoginAlerts: v.optional(v.boolean()),
    e2eeEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const existing = await ctx.db
      .query("securitySettings")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        suspiciousLoginAlerts:
          args.suspiciousLoginAlerts ?? existing.suspiciousLoginAlerts,
        e2eeEnabled: args.e2eeEnabled ?? existing.e2eeEnabled,
        updatedAt: Date.now(),
      });
      return { updated: true };
    }

    await ctx.db.insert("securitySettings", {
      userId: me._id,
      suspiciousLoginAlerts: args.suspiciousLoginAlerts ?? true,
      e2eeEnabled: args.e2eeEnabled ?? false,
      updatedAt: Date.now(),
    });

    return { updated: true };
  },
});

export const listMyDeviceSessions = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUserOrThrow(ctx);
    const sessions = await ctx.db
      .query("deviceSessions")
      .withIndex("by_userId", (q) => q.eq("userId", me._id))
      .collect();

    return sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  },
});

export const revokeDeviceSession = mutation({
  args: {
    sessionId: v.id("deviceSessions"),
  },
  handler: async (ctx, args) => {
    const me = await getCurrentUserOrThrow(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== me._id) {
      throw new Error("Not found");
    }

    await ctx.db.patch(args.sessionId, {
      isActive: false,
      lastSeenAt: Date.now(),
    });

    return { revoked: true };
  },
});

async function getCurrentUser(ctx: MutationCtx | QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
}
