import type * as conversations from "../conversations.js";
import type * as lib_auth from "../lib/auth.js";
import type * as messages from "../messages.js";
import type * as presence from "../presence.js";
import type * as typing from "../typing.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  conversations: typeof conversations;
  "lib/auth": typeof lib_auth;
  messages: typeof messages;
  presence: typeof presence;
  typing: typeof typing;
  users: typeof users;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
