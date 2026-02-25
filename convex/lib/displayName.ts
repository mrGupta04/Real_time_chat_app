type UserLike = {
  name?: string;
  email?: string;
} | null | undefined;

export const resolveUserDisplayName = (user: UserLike) => {
  const rawName = user?.name?.trim();
  if (rawName && rawName.toLowerCase() !== "anonymous") {
    return rawName;
  }

  const emailPrefix = user?.email?.split("@")[0]?.trim();
  if (emailPrefix) {
    return emailPrefix;
  }

  return "User";
};