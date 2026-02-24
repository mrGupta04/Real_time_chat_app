"use client";

import {
  SignInButton,
  SignOutButton,
  SignedIn,
  SignedOut,
  UserButton,
  useUser,
} from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { formatTimestamp } from "@/lib/formatTimestamp";
import { Providers } from "./providers";

export const dynamic = "force-dynamic";

const REACTIONS = ["👍", "❤️", "😂", "😮", "😢"] as const;

type UserRow = {
  _id: Id<"users">;
  name: string;
  imageUrl?: string;
  isOnline: boolean;
};

type ConversationRow = {
  _id: Id<"conversations">;
  title: string;
  isGroup: boolean;
  memberCount: number;
  unreadCount: number;
  lastMessageText?: string;
  lastMessageAt?: number;
};

type MessageRow = {
  _id: Id<"messages">;
  body: string;
  deleted: boolean;
  createdAt: number;
  senderName: string;
  isOwn: boolean;
  reactionCounts: Array<{
    emoji: string;
    count: number;
    reactedByMe: boolean;
  }>;
};

type SelectedConversation = {
  _id: Id<"conversations">;
  title: string;
  isGroup: boolean;
  memberCount: number;
};

type TypingUser = {
  userId: Id<"users">;
  name: string;
};

export default function Home() {
  const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const clerkConfigured =
    !!clerkKey && clerkKey.startsWith("pk_") && !clerkKey.includes("replace");

  if (!clerkConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
        <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-700">
          <h1 className="text-lg font-semibold text-zinc-900">
            Clerk configuration required
          </h1>
          <p className="mt-2">
            Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in
            .env.local, then restart the app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Providers>
      <ChatApp />
    </Providers>
  );
}

function ChatApp() {
  const { user, isSignedIn } = useUser();
  const upsertCurrentUser = useMutation(api.users.upsertCurrentUser);
  const openConversation = useMutation(
    api.conversations.getOrCreateDirectConversation,
  );
  const createGroupConversation = useMutation(
    api.conversations.createGroupConversation,
  );
  const markConversationRead = useMutation(api.conversations.markAsRead);
  const sendMessage = useMutation(api.messages.send);
  const deleteOwnMessage = useMutation(api.messages.deleteOwnMessage);
  const toggleReaction = useMutation(api.messages.toggleReaction);
  const updateTyping = useMutation(api.typing.updateTyping);
  const heartbeat = useMutation(api.presence.heartbeat);

  const [search, setSearch] = useState("");
  const [selectedConversationId, setSelectedConversationId] =
    useState<Id<"conversations"> | null>(null);
  const [draftMessage, setDraftMessage] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<{
    conversationId: Id<"conversations">;
    body: string;
  } | null>(null);

  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<Id<"users">[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<Id<"messages"> | null>(null);

  const users = useQuery(
    api.users.listUsers,
    isSignedIn ? { search } : "skip",
  ) as
    | UserRow[]
    | undefined;
  const conversations = useQuery(
    api.conversations.listForCurrentUser,
    isSignedIn ? {} : "skip",
  ) as ConversationRow[] | undefined;
  const selectedConversation = useQuery(
    api.conversations.getConversation,
    isSignedIn && selectedConversationId
      ? { conversationId: selectedConversationId }
      : "skip",
  ) as SelectedConversation | undefined;
  const messages = useQuery(
    api.messages.list,
    isSignedIn && selectedConversationId
      ? { conversationId: selectedConversationId }
      : "skip",
  ) as MessageRow[] | undefined;
  const typingUsers = useQuery(
    api.typing.listTypingUsers,
    isSignedIn && selectedConversationId
      ? { conversationId: selectedConversationId }
      : "skip",
  ) as TypingUser[] | undefined;

  useEffect(() => {
    if (isSignedIn) {
      void upsertCurrentUser({}).catch(() => undefined);
      const interval = window.setInterval(() => {
        void upsertCurrentUser({}).catch(() => undefined);
      }, 10_000);

      return () => window.clearInterval(interval);
    }

    return;
  }, [isSignedIn, upsertCurrentUser, user?.id]);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }

    void heartbeat({}).catch(() => undefined);
    const interval = window.setInterval(() => {
      void heartbeat({}).catch(() => undefined);
    }, 15_000);

    return () => window.clearInterval(interval);
  }, [heartbeat, isSignedIn]);

  useEffect(() => {
    if (!selectedConversationId) {
      return;
    }

    void markConversationRead({ conversationId: selectedConversationId });
  }, [markConversationRead, selectedConversationId, messages?.length]);

  useEffect(() => {
    if (!selectedConversationId) {
      return;
    }

    const nextTyping = draftMessage.trim().length > 0;
    const timeout = window.setTimeout(() => {
      void updateTyping({
        conversationId: selectedConversationId,
        isTyping: nextTyping,
      });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [draftMessage, selectedConversationId, updateTyping]);

  useEffect(() => {
    if (!selectedConversationId) {
      return;
    }

    const node = messageListRef.current;
    if (!node || !messages) {
      return;
    }

    const latestMessageId = messages[messages.length - 1]?._id ?? null;
    const hasNewMessage =
      latestMessageId !== null && latestMessageId !== lastMessageIdRef.current;

    if (hasNewMessage) {
      if (isNearBottom) {
        node.scrollTop = node.scrollHeight;
        window.requestAnimationFrame(() => setShowNewMessagesButton(false));
      } else {
        window.requestAnimationFrame(() => setShowNewMessagesButton(true));
      }
      lastMessageIdRef.current = latestMessageId;
    }
  }, [isNearBottom, messages, selectedConversationId]);

  const typingText = useMemo(() => {
    if (!typingUsers || typingUsers.length === 0) {
      return null;
    }

    if (typingUsers.length === 1) {
      return `${typingUsers[0].name} is typing...`;
    }

    return `${typingUsers[0].name} and others are typing...`;
  }, [typingUsers]);

  const selectConversation = (conversationId: Id<"conversations"> | null) => {
    setSelectedConversationId(conversationId);
    setDraftMessage("");
    setSendError(null);
    setFailedMessage(null);
    setShowNewMessagesButton(false);
    setIsNearBottom(true);
    lastMessageIdRef.current = null;
  };

  const handleSelectUser = async (otherUserId: Id<"users">) => {
    const conversationId = await openConversation({ otherUserId });
    selectConversation(conversationId);
    setCreatingGroup(false);
  };

  const handleCreateGroup = async () => {
    setGroupError(null);

    if (groupName.trim().length === 0) {
      setGroupError("Group name is required.");
      return;
    }

    if (groupMemberIds.length < 2) {
      setGroupError("Pick at least 2 members.");
      return;
    }

    try {
      const conversationId = await createGroupConversation({
        name: groupName,
        memberIds: groupMemberIds,
      });
      selectConversation(conversationId);
      setCreatingGroup(false);
      setGroupName("");
      setGroupMemberIds([]);
    } catch {
      setGroupError("Could not create group. Please try again.");
    }
  };

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    setSendError(null);

    if (!selectedConversationId || !draftMessage.trim()) {
      return;
    }

    const payload = {
      conversationId: selectedConversationId,
      body: draftMessage,
    };

    try {
      await sendMessage(payload);
      setDraftMessage("");
      setFailedMessage(null);
    } catch {
      setFailedMessage(payload);
      setSendError("Failed to send message.");
    }
  };

  const handleRetrySend = async () => {
    if (!failedMessage) {
      return;
    }

    setSendError(null);
    try {
      await sendMessage(failedMessage);
      setDraftMessage("");
      setFailedMessage(null);
    } catch {
      setSendError("Message retry failed. Check your network and retry.");
    }
  };

  const handleDeleteMessage = async (messageId: Id<"messages">) => {
    await deleteOwnMessage({ messageId });
  };

  const handleToggleReaction = async (
    messageId: Id<"messages">,
    emoji: (typeof REACTIONS)[number],
  ) => {
    await toggleReaction({ messageId, emoji });
  };

  const toggleGroupMember = (memberId: Id<"users">) => {
    setGroupMemberIds((prev) =>
      prev.includes(memberId)
        ? prev.filter((id) => id !== memberId)
        : [...prev, memberId],
    );
  };

  const onMessageListScroll = () => {
    const node = messageListRef.current;
    if (!node) {
      return;
    }

    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    setIsNearBottom(nearBottom);
    if (nearBottom) {
      setShowNewMessagesButton(false);
    }
  };

  const scrollToLatest = () => {
    const node = messageListRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    setShowNewMessagesButton(false);
    setIsNearBottom(true);
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      <SignedOut>
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-zinc-900">Livechat</h1>
            <p className="mt-2 text-sm text-zinc-600">
              Sign in to find users and start messaging in real time.
            </p>
            <SignInButton mode="modal">
              <button className="mt-6 w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800">
                Sign in / Sign up
              </button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>

      <SignedIn>
        <header className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-4">
          <div className="flex items-center gap-3">
            <div className="text-lg font-semibold text-zinc-900">Livechat</div>
            {user?.fullName && (
              <div className="hidden text-sm text-zinc-600 sm:block">
                {user.fullName}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <UserButton />
            <SignOutButton>
              <button className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
                Log out
              </button>
            </SignOutButton>
          </div>
        </header>

        <main className="flex h-[calc(100vh-3.5rem)]">
          <aside
            className={`${
              selectedConversationId ? "hidden md:flex" : "flex"
            } w-full shrink-0 flex-col border-r border-zinc-200 bg-white md:w-96`}
          >
            <div className="border-b border-zinc-200 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-zinc-900">Find users</h2>
                <button
                  onClick={() => {
                    setCreatingGroup((prev) => !prev);
                    setGroupError(null);
                  }}
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                >
                  {creatingGroup ? "Cancel" : "New group"}
                </button>
              </div>

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name"
                className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none ring-zinc-300 focus:ring"
              />

              {creatingGroup && (
                <div className="mt-3 rounded-md border border-zinc-200 p-2">
                  <input
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                    placeholder="Group name"
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none ring-zinc-300 focus:ring"
                  />
                  <div className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                    {users?.map((chatUser) => (
                      <label
                        key={`group-${chatUser._id}`}
                        className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-zinc-100"
                      >
                        <span className="truncate">{chatUser.name}</span>
                        <input
                          type="checkbox"
                          checked={groupMemberIds.includes(chatUser._id)}
                          onChange={() => toggleGroupMember(chatUser._id)}
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={handleCreateGroup}
                    className="mt-2 w-full rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-800"
                  >
                    Create group
                  </button>
                  {groupError && (
                    <p className="mt-1 text-xs text-red-600">{groupError}</p>
                  )}
                </div>
              )}

              <div className="mt-3 max-h-32 overflow-y-auto">
                {users === undefined ? (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-8 animate-pulse rounded-md bg-zinc-100"
                      />
                    ))}
                  </div>
                ) : users.length === 0 ? (
                  <p className="text-sm text-zinc-500">No search results.</p>
                ) : (
                  <div className="space-y-1">
                    {users.map((chatUser) => (
                      <button
                        key={chatUser._id}
                        onClick={() => handleSelectUser(chatUser._id)}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              chatUser.isOnline ? "bg-green-500" : "bg-zinc-300"
                            }`}
                          />
                          <span className="truncate">{chatUser.name}</span>
                        </span>
                        <span className="text-xs text-zinc-500">Message</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              <h2 className="px-2 pb-2 text-sm font-semibold text-zinc-900">
                Conversations
              </h2>
              {conversations === undefined ? (
                <div className="space-y-2 px-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-12 animate-pulse rounded-md bg-zinc-100"
                    />
                  ))}
                </div>
              ) : conversations.length === 0 ? (
                <p className="px-2 text-sm text-zinc-500">
                  No conversations yet. Search for a user to start chatting.
                </p>
              ) : (
                <div className="space-y-1">
                  {conversations.map((conversation) => (
                    <button
                      key={conversation._id}
                      onClick={() => selectConversation(conversation._id)}
                      className={`w-full rounded-md px-3 py-2 text-left hover:bg-zinc-100 ${
                        selectedConversationId === conversation._id
                          ? "bg-zinc-100"
                          : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {conversation.title}
                          {conversation.isGroup
                            ? ` (${conversation.memberCount})`
                            : ""}
                        </p>
                        <div className="flex items-center gap-2">
                          {conversation.unreadCount > 0 && (
                            <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] text-white">
                              {conversation.unreadCount}
                            </span>
                          )}
                          {conversation.lastMessageAt && (
                            <p className="shrink-0 text-xs text-zinc-500">
                              {formatTimestamp(conversation.lastMessageAt)}
                            </p>
                          )}
                        </div>
                      </div>
                      <p className="truncate text-xs text-zinc-500">
                        {conversation.lastMessageText ?? "No messages yet"}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <section
            className={`${
              selectedConversationId ? "flex" : "hidden md:flex"
            } flex-1 flex-col`}
          >
            {!selectedConversationId ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-zinc-500">
                Select a conversation from the sidebar to start messaging.
              </div>
            ) : (
              <>
                <div className="flex h-14 items-center gap-3 border-b border-zinc-200 bg-white px-4">
                  <button
                    onClick={() => selectConversation(null)}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 md:hidden"
                  >
                    Back
                  </button>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">
                      {selectedConversation?.title ?? "Loading..."}
                    </p>
                    {selectedConversation?.isGroup && (
                      <p className="text-xs text-zinc-500">
                        {selectedConversation.memberCount} members
                      </p>
                    )}
                  </div>
                </div>

                <div className="relative flex-1 overflow-hidden">
                  <div
                    ref={messageListRef}
                    onScroll={onMessageListScroll}
                    className="h-full space-y-3 overflow-y-auto p-4"
                  >
                    {messages === undefined ? (
                      <div className="space-y-3">
                        {[0, 1, 2, 3].map((i) => (
                          <div
                            key={i}
                            className="h-14 animate-pulse rounded-lg bg-zinc-100"
                          />
                        ))}
                      </div>
                    ) : messages.length === 0 ? (
                      <p className="text-sm text-zinc-500">
                        No messages yet. Send the first message.
                      </p>
                    ) : (
                      messages.map((message) => {
                        const reactionMap = new Map(
                          message.reactionCounts.map((item) => [item.emoji, item]),
                        );

                        return (
                          <div
                            key={message._id}
                            className={`flex ${
                              message.isOwn ? "justify-end" : "justify-start"
                            }`}
                          >
                            <div
                              className={`max-w-[90%] rounded-lg px-3 py-2 ${
                                message.isOwn
                                  ? "bg-zinc-900 text-white"
                                  : "border border-zinc-200 bg-white text-zinc-900"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <p className="text-xs opacity-75">{message.senderName}</p>
                                {message.isOwn && !message.deleted && (
                                  <button
                                    onClick={() => handleDeleteMessage(message._id)}
                                    className="text-[10px] opacity-70 hover:opacity-100"
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>

                              {message.deleted ? (
                                <p className="text-sm italic opacity-75">
                                  This message was deleted
                                </p>
                              ) : (
                                <p className="text-sm">{message.body}</p>
                              )}

                              <p className="mt-1 text-[11px] opacity-75">
                                {formatTimestamp(message.createdAt)}
                              </p>

                              <div className="mt-2 flex flex-wrap gap-1">
                                {REACTIONS.map((emoji) => {
                                  const current = reactionMap.get(emoji);
                                  return (
                                    <button
                                      key={`${message._id}-${emoji}`}
                                      onClick={() =>
                                        handleToggleReaction(message._id, emoji)
                                      }
                                      className={`rounded-full border px-2 py-0.5 text-xs ${
                                        current?.reactedByMe
                                          ? "border-zinc-900"
                                          : "border-zinc-300"
                                      }`}
                                    >
                                      {emoji}
                                      {current?.count ? ` ${current.count}` : ""}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    {typingText && (
                      <p className="text-xs text-zinc-500">{typingText}</p>
                    )}
                  </div>

                  {showNewMessagesButton && (
                    <button
                      onClick={scrollToLatest}
                      className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700 shadow-sm"
                    >
                      ↓ New messages
                    </button>
                  )}
                </div>

                <form
                  onSubmit={handleSend}
                  className="border-t border-zinc-200 bg-white p-3"
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={draftMessage}
                      onChange={(event) => setDraftMessage(event.target.value)}
                      placeholder="Type a message"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none ring-zinc-300 focus:ring"
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800"
                    >
                      Send
                    </button>
                  </div>
                  {sendError && (
                    <div className="mt-2 flex items-center gap-2">
                      <p className="text-xs text-red-600">{sendError}</p>
                      {failedMessage && (
                        <button
                          type="button"
                          onClick={handleRetrySend}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </form>
              </>
            )}
          </section>
        </main>
      </SignedIn>
    </div>
  );
}
