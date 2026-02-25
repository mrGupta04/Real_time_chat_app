import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function isBlockedBetween(
  ctx: MutationCtx | QueryCtx,
  userAId: Id<"users">,
  userBId: Id<"users">,
) {
  const aBlockedB = await ctx.db
    .query("blocks")
    .withIndex("by_blockerId_blockedId", (q) =>
      q.eq("blockerId", userAId).eq("blockedId", userBId),
    )
    .unique();

  if (aBlockedB) {
    return true;
  }

  const bBlockedA = await ctx.db
    .query("blocks")
    .withIndex("by_blockerId_blockedId", (q) =>
      q.eq("blockerId", userBId).eq("blockedId", userAId),
    )
    .unique();

  return !!bBlockedA;
}
