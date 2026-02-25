import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function getOrCreatePrivacySettings(
  ctx: MutationCtx | QueryCtx,
  userId: Id<"users">,
) {
  const existing = await ctx.db
    .query("privacySettings")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

  if (existing) {
    return existing;
  }

  return {
    userId,
    readReceiptsEnabled: true,
    lastSeenVisibility: "everyone" as const,
    whoCanMessage: "everyone" as const,
    updatedAt: 0,
  };
}

export async function canMessageUser(
  ctx: MutationCtx | QueryCtx,
  senderId: Id<"users">,
  recipientId: Id<"users">,
) {
  const senderSettings = await getOrCreatePrivacySettings(ctx, senderId);
  const recipientSettings = await getOrCreatePrivacySettings(ctx, recipientId);

  if (senderSettings.whoCanMessage === "nobody") {
    return false;
  }

  if (recipientSettings.whoCanMessage === "nobody") {
    return false;
  }

  return true;
}
