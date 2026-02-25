"use client";

import {
  SignInButton,
  SignOutButton,
  SignedIn,
  SignedOut,
  UserButton,
  useUser,
} from "@clerk/nextjs";
import Image from "next/image";
import { useMutation, useQuery } from "convex/react";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { formatTimestamp } from "@/lib/formatTimestamp";
import { Providers } from "./providers";

export const dynamic = "force-dynamic";

const REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🔥",
  "🎉",
  "🙏",
  "👀",
  "😍",
  "😎",
  "🤔",
] as const;

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
  myRole?: "owner" | "admin" | "member";
  memberCount: number;
  unreadCount: number;
  imageUrl?: string;
  lastMessageText?: string;
  lastMessageAt?: number;
};

type MessageRow = {
  _id: Id<"messages">;
  body: string;
  deleted: boolean;
  createdAt: number;
  mediaType?: "image" | "video" | "audio";
  mediaUrl?: string | null;
  replyTo?: {
    messageId: Id<"messages">;
    senderName: string;
    body: string;
    mediaType?: "image" | "video" | "audio";
  } | null;
  senderName: string;
  senderImageUrl?: string;
  isOwn: boolean;
  editedAt?: number | null;
  editCount?: number;
  isStarred?: boolean;
  status?: "sent" | "delivered" | "read" | null;
  seenBy?: Array<{ userId: Id<"users">; name: string }>;
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
  myRole?: "owner" | "admin" | "member";
  memberCount: number;
  imageUrl?: string;
  otherUserId?: Id<"users">;
};

type TypingUser = {
  userId: Id<"users">;
  name: string;
};

type BlockedUserRow = {
  _id: Id<"users">;
  name: string;
  imageUrl?: string;
};

type GroupMemberRow = {
  membershipId: Id<"conversationMembers">;
  userId: Id<"users">;
  name: string;
  imageUrl?: string;
  role: "owner" | "admin" | "member";
};

type MessageEditRow = {
  _id: Id<"messageEdits">;
  previousBody: string;
  editedAt: number;
};

type UploadQueueItem = {
  id: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "failed" | "completed";
  error?: string;
  caption?: string;
  replyToMessageId?: Id<"messages">;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function Avatar({
  name,
  imageUrl,
  size = "md",
}: {
  name: string;
  imageUrl?: string;
  size?: "sm" | "md";
}) {
  const classes = size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs";
  const imageSize = size === "sm" ? 24 : 32;
  const initials = name
    .split(" ")
    .map((part) => part.trim()[0])
    .filter((char): char is string => !!char)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (imageUrl) {
    return (
      <Image
        src={imageUrl}
        alt={name}
        width={imageSize}
        height={imageSize}
        unoptimized
        className={`${classes} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-zinc-200 font-medium text-zinc-700`}
      aria-label={name}
    >
      {initials || "U"}
    </div>
  );
}

function uploadFileWithProgress(
  uploadUrl: string,
  file: File,
  onProgress: (progress: number) => void,
) {
  return new Promise<Id<"_storage">>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) {
        return;
      }
      onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error("Upload failed"));
        return;
      }

      try {
        const result = JSON.parse(xhr.responseText) as { storageId: Id<"_storage"> };
        resolve(result.storageId);
      } catch {
        reject(new Error("Invalid upload response"));
      }
    };

    xhr.send(file);
  });
}

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
  const deleteConversationForMe = useMutation(
    api.conversations.deleteConversationForMe,
  );
  const markConversationRead = useMutation(api.conversations.markAsRead);
  const sendMessage = useMutation(api.messages.send);
  const sendMedia = useMutation(api.messages.sendMedia);
  const generateUploadUrl = useMutation(api.messages.generateUploadUrl);
  const editOwnMessage = useMutation(api.messages.editOwnMessage);
  const deleteOwnMessage = useMutation(api.messages.deleteOwnMessage);
  const toggleReaction = useMutation(api.messages.toggleReaction);
  const toggleStar = useMutation(api.messages.toggleStar);
  const addGroupMembers = useMutation(api.conversations.addGroupMembers);
  const removeGroupMember = useMutation(api.conversations.removeGroupMember);
  const updateGroupMemberRole = useMutation(api.conversations.updateGroupMemberRole);
  const updateMyPrivacySettings = useMutation(api.users.updateMyPrivacySettings);
  const updateMySecuritySettings = useMutation(api.users.updateMySecuritySettings);
  const toggleBlockUser = useMutation(api.users.toggleBlockUser);
  const updateTyping = useMutation(api.typing.updateTyping);
  const heartbeat = useMutation(api.presence.heartbeat);

  const [search, setSearch] = useState("");
  const [selectedConversationId, setSelectedConversationId] =
    useState<Id<"conversations"> | null>(null);
  const [draftMessage, setDraftMessage] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<{
    messageId: Id<"messages">;
    senderName: string;
    body: string;
    mediaType?: "image" | "video" | "audio";
  } | null>(null);
  const [failedMessage, setFailedMessage] = useState<{
    conversationId: Id<"conversations">;
    body: string;
    replyToMessageId?: Id<"messages">;
  } | null>(null);

  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<Id<"users">[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [oldestLoadedCreatedAt, setOldestLoadedCreatedAt] = useState<number | null>(
    null,
  );
  const [requestedOlderCursor, setRequestedOlderCursor] = useState<number | null>(
    null,
  );
  const [olderMessages, setOlderMessages] = useState<MessageRow[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordingWaveform, setRecordingWaveform] = useState<number[]>([]);
  const [audioPlaybackRate, setAudioPlaybackRate] = useState(1);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    Id<"messages"> | null
  >(null);
  const [editingMessageId, setEditingMessageId] = useState<Id<"messages"> | null>(
    null,
  );
  const [editingBody, setEditingBody] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [searchMediaType, setSearchMediaType] = useState<
    "all" | "image" | "video" | "audio"
  >("all");
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [newGroupMembers, setNewGroupMembers] = useState<Id<"users">[]>([]);
  const [historyMessageId, setHistoryMessageId] = useState<Id<"messages"> | null>(
    null,
  );
  const [globalSenderId, setGlobalSenderId] = useState<"all" | Id<"users">>("all");
  const [conversationSenderId, setConversationSenderId] = useState<
    "all" | Id<"users">
  >("all");
  const [globalFromDate, setGlobalFromDate] = useState("");
  const [globalToDate, setGlobalToDate] = useState("");
  const [conversationFromDate, setConversationFromDate] = useState("");
  const [conversationToDate, setConversationToDate] = useState("");

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<Id<"messages"> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const globalSearchInputRef = useRef<HTMLInputElement | null>(null);
  const messageNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingAnalyserRef = useRef<AnalyserNode | null>(null);
  const waveformAnimationRef = useRef<number | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);

  const users = useQuery(
    api.users.listUsers,
    isSignedIn ? { search } : "skip",
  ) as
    | UserRow[]
    | undefined;
  const me = useQuery(api.users.me, isSignedIn ? {} : "skip");
  const blockedUsers = useQuery(
    api.users.listBlockedUsers,
    isSignedIn ? {} : "skip",
  ) as BlockedUserRow[] | undefined;
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
  const latestMessagePage = useQuery(
    api.messages.list,
    isSignedIn && selectedConversationId
      ? { conversationId: selectedConversationId, limit: 40 }
      : "skip",
  ) as
    | { items: MessageRow[]; oldestCreatedAt: number | null; hasMore: boolean }
    | undefined;
  const olderMessagePage = useQuery(
    api.messages.list,
    isSignedIn && selectedConversationId && requestedOlderCursor !== null
      ? {
          conversationId: selectedConversationId,
          beforeCreatedAt: requestedOlderCursor,
          limit: 40,
        }
      : "skip",
  ) as
    | { items: MessageRow[]; oldestCreatedAt: number | null; hasMore: boolean }
    | undefined;
  const typingUsers = useQuery(
    api.typing.listTypingUsers,
    isSignedIn && selectedConversationId
      ? { conversationId: selectedConversationId }
      : "skip",
  ) as TypingUser[] | undefined;
  const myPrivacy = useQuery(api.users.getMyPrivacySettings, isSignedIn ? {} : "skip");
  const mySecurity = useQuery(api.users.getMySecuritySettings, isSignedIn ? {} : "skip");
  const groupMembers = useQuery(
    api.conversations.listGroupMembers,
    isSignedIn && selectedConversationId && selectedConversation?.isGroup
      ? { conversationId: selectedConversationId }
      : "skip",
  ) as GroupMemberRow[] | undefined;
  const starredMessages = useQuery(
    api.messages.listStarred,
    isSignedIn && selectedConversationId
      ? { conversationId: selectedConversationId }
      : "skip",
  );
  const conversationSearchResults = useQuery(
    api.messages.searchInConversation,
    isSignedIn && selectedConversationId && conversationSearch.trim().length > 0
      ? {
          conversationId: selectedConversationId,
          text: conversationSearch,
          mediaType: searchMediaType === "all" ? undefined : searchMediaType,
          senderId:
            conversationSenderId === "all" ? undefined : conversationSenderId,
          fromDate: conversationFromDate
            ? new Date(`${conversationFromDate}T00:00:00`).getTime()
            : undefined,
          toDate: conversationToDate
            ? new Date(`${conversationToDate}T23:59:59`).getTime()
            : undefined,
        }
      : "skip",
  );
  const globalSearchResults = useQuery(
    api.messages.searchGlobal,
    isSignedIn && globalSearch.trim().length > 0
      ? {
          text: globalSearch,
          mediaType: searchMediaType === "all" ? undefined : searchMediaType,
          senderId: globalSenderId === "all" ? undefined : globalSenderId,
          fromDate: globalFromDate
            ? new Date(`${globalFromDate}T00:00:00`).getTime()
            : undefined,
          toDate: globalToDate
            ? new Date(`${globalToDate}T23:59:59`).getTime()
            : undefined,
        }
      : "skip",
  );
  const editHistory = useQuery(
    api.messages.getEditHistory,
    isSignedIn && historyMessageId ? { messageId: historyMessageId } : "skip",
  ) as MessageEditRow[] | undefined;

  const messages = useMemo(() => {
    const latest = latestMessagePage?.items ?? [];
    const merged = [...olderMessages, ...latest];
    const seen = new Set<string>();
    return merged.filter((message) => {
      const key = String(message._id);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [latestMessagePage?.items, olderMessages]);
  const isMessagesLoading = latestMessagePage === undefined;

  const globalSenderOptions = useMemo(() => {
    const rows: Array<{ userId: Id<"users">; name: string }> = [];
    if (me?._id) {
      rows.push({ userId: me._id, name: `${me.name} (You)` });
    }
    for (const user of users ?? []) {
      rows.push({ userId: user._id, name: user.name });
    }
    return rows;
  }, [me?._id, me?.name, users]);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }

    if (me) {
      return;
    }

    void upsertCurrentUser({}).catch(() => undefined);
    const interval = window.setInterval(() => {
      void upsertCurrentUser({}).catch(() => undefined);
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [isSignedIn, me, upsertCurrentUser, user?.id]);

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
  }, [markConversationRead, selectedConversationId, messages.length]);

  useEffect(() => {
    setOlderMessages([]);
    setRequestedOlderCursor(null);
    setOldestLoadedCreatedAt(null);
    setHasMoreHistory(true);
  }, [selectedConversationId]);

  useEffect(() => {
    if (!latestMessagePage) {
      return;
    }
    setOldestLoadedCreatedAt((prev) => {
      if (prev === null) {
        return latestMessagePage.oldestCreatedAt;
      }
      if (latestMessagePage.oldestCreatedAt === null) {
        return prev;
      }
      return Math.min(prev, latestMessagePage.oldestCreatedAt);
    });
    setHasMoreHistory(latestMessagePage.hasMore);
  }, [latestMessagePage]);

  useEffect(() => {
    if (!olderMessagePage || requestedOlderCursor === null) {
      return;
    }

    setOlderMessages((prev) => {
      const next = [...prev, ...olderMessagePage.items];
      const seen = new Set<string>();
      return next.filter((message) => {
        const key = String(message._id);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    });
    setOldestLoadedCreatedAt(olderMessagePage.oldestCreatedAt);
    setHasMoreHistory(olderMessagePage.hasMore);
    setRequestedOlderCursor(null);
  }, [olderMessagePage, requestedOlderCursor]);

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
    if (!node || messages.length === 0) {
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

  useEffect(() => {
    if (!highlightedMessageId) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setHighlightedMessageId(null);
    }, 1_200);

    return () => window.clearTimeout(timeout);
  }, [highlightedMessageId]);

  useEffect(() => {
    return () => {
      if (waveformAnimationRef.current !== null) {
        window.cancelAnimationFrame(waveformAnimationRef.current);
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (recordingAudioContextRef.current) {
        void recordingAudioContextRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowHeaderMenu(true);
        window.requestAnimationFrame(() => {
          globalSearchInputRef.current?.focus();
        });
        return;
      }

      if (event.key === "Escape" && historyMessageId) {
        setHistoryMessageId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyMessageId, selectedConversationId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (headerMenuRef.current?.contains(target)) {
        return;
      }

      setShowHeaderMenu(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (isUploadingMedia || uploadQueue.length === 0 || !selectedConversationId) {
      return;
    }

    const nextItem = uploadQueue.find((item) => item.status === "queued");
    if (!nextItem) {
      return;
    }

    const nextFile = nextItem.file;

    const processQueue = async () => {
      const isImage = nextFile.type.startsWith("image/");
      const isVideo = nextFile.type.startsWith("video/");
      const isAudio = nextFile.type.startsWith("audio/");

      if (!isImage && !isVideo && !isAudio) {
        const error = "Only image, video, and audio files are supported.";
        setSendError(error);
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === nextItem.id
              ? { ...item, status: "failed", error, progress: 0 }
              : item,
          ),
        );
        return;
      }

      if (isImage && nextFile.size > MAX_IMAGE_BYTES) {
        const error = "Image is too large. Max size is 10MB.";
        setSendError(error);
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === nextItem.id
              ? { ...item, status: "failed", error, progress: 0 }
              : item,
          ),
        );
        return;
      }

      if (isVideo && nextFile.size > MAX_VIDEO_BYTES) {
        const error = "Video is too large. Max size is 20MB.";
        setSendError(error);
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === nextItem.id
              ? { ...item, status: "failed", error, progress: 0 }
              : item,
          ),
        );
        return;
      }

      if (isAudio && nextFile.size > MAX_AUDIO_BYTES) {
        const error = "Audio is too large. Max size is 12MB.";
        setSendError(error);
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === nextItem.id
              ? { ...item, status: "failed", error, progress: 0 }
              : item,
          ),
        );
        return;
      }

      setIsUploadingMedia(true);
      setSendError(null);
      setUploadQueue((prev) =>
        prev.map((item) =>
          item.id === nextItem.id ? { ...item, status: "uploading", progress: 0 } : item,
        ),
      );

      try {
        const uploadUrl = await generateUploadUrl({});
        const storageId = await uploadFileWithProgress(uploadUrl, nextFile, (progress) => {
          setUploadQueue((prev) =>
            prev.map((item) => (item.id === nextItem.id ? { ...item, progress } : item)),
          );
        });

        await sendMedia({
          conversationId: selectedConversationId,
          storageId,
          mediaType: isImage ? "image" : isVideo ? "video" : "audio",
          caption: nextItem.caption,
          replyToMessageId: nextItem.replyToMessageId,
        });
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === nextItem.id
              ? { ...item, status: "completed", progress: 100, error: undefined }
              : item,
          ),
        );
      } catch {
        const error = "Failed to upload media.";
        setSendError(error);
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === nextItem.id ? { ...item, status: "failed", error } : item,
          ),
        );
      } finally {
        setIsUploadingMedia(false);
      }
    };

    void processQueue();
  }, [
    isUploadingMedia,
    uploadQueue,
    selectedConversationId,
    generateUploadUrl,
    sendMedia,
  ]);

  const handleRetryUpload = (itemId: string) => {
    setUploadQueue((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? { ...item, status: "queued", progress: 0, error: undefined }
          : item,
      ),
    );
  };

  const handleRemoveUploadItem = (itemId: string) => {
    setUploadQueue((prev) => prev.filter((item) => item.id !== itemId));
  };

  const handleClearUploadQueue = () => {
    setUploadQueue((prev) =>
      prev.filter((item) => item.status === "uploading" || item.status === "queued"),
    );
  };

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
    setReplyToMessage(null);
    setSendError(null);
    setFailedMessage(null);
    setHistoryMessageId(null);
    setConversationSearch("");
    setConversationSenderId("all");
    setConversationFromDate("");
    setConversationToDate("");
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

    if (!selectedConversationId || !draftMessage.trim() || isUploadingMedia) {
      return;
    }

    const payload = {
      conversationId: selectedConversationId,
      body: draftMessage,
      replyToMessageId: replyToMessage?.messageId,
    };

    try {
      await sendMessage(payload);
      setDraftMessage("");
      setReplyToMessage(null);
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
      setReplyToMessage(null);
      setFailedMessage(null);
    } catch {
      setSendError("Message retry failed. Check your network and retry.");
    }
  };

  const handlePickMedia = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setUploadQueue((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        progress: 0,
        status: "queued",
        caption: draftMessage.trim() || undefined,
        replyToMessageId: replyToMessage?.messageId,
      },
    ]);
    setDraftMessage("");
    setReplyToMessage(null);
    setFailedMessage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleToggleRecording = async () => {
    if (!isRecordingAudio) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingStreamRef.current = stream;

        const recorder = new MediaRecorder(stream);
        mediaChunksRef.current = [];

        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 128;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        recordingAudioContextRef.current = audioContext;
        recordingAnalyserRef.current = analyser;

        const waveformData = new Uint8Array(analyser.frequencyBinCount);
        const drawWaveform = () => {
          const activeAnalyser = recordingAnalyserRef.current;
          if (!activeAnalyser) {
            return;
          }
          activeAnalyser.getByteTimeDomainData(waveformData);
          const barCount = 20;
          const chunkSize = Math.floor(waveformData.length / barCount);
          const nextWaveform: number[] = [];

          for (let index = 0; index < barCount; index += 1) {
            let sum = 0;
            const start = index * chunkSize;
            const end = start + chunkSize;
            for (let point = start; point < end; point += 1) {
              sum += Math.abs(waveformData[point] - 128);
            }
            const avg = chunkSize > 0 ? sum / chunkSize : 0;
            nextWaveform.push(Math.max(6, Math.min(100, avg * 1.8)));
          }

          setRecordingWaveform(nextWaveform);
          waveformAnimationRef.current = window.requestAnimationFrame(drawWaveform);
        };

        waveformAnimationRef.current = window.requestAnimationFrame(drawWaveform);

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            mediaChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = () => {
          const blob = new Blob(mediaChunksRef.current, { type: "audio/webm" });
          const voiceFile = new File([blob], `voice-${Date.now()}.webm`, {
            type: "audio/webm",
          });
          setUploadQueue((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              file: voiceFile,
              progress: 0,
              status: "queued",
              caption: draftMessage.trim() || undefined,
              replyToMessageId: replyToMessage?.messageId,
            },
          ]);
          setDraftMessage("");
          setReplyToMessage(null);
          setFailedMessage(null);

          if (waveformAnimationRef.current !== null) {
            window.cancelAnimationFrame(waveformAnimationRef.current);
            waveformAnimationRef.current = null;
          }
          recordingAnalyserRef.current = null;
          if (recordingAudioContextRef.current) {
            void recordingAudioContextRef.current.close();
            recordingAudioContextRef.current = null;
          }
          recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
          recordingStreamRef.current = null;
          setRecordingWaveform([]);
        };

        recorder.start();
        mediaRecorderRef.current = recorder;
        setIsRecordingAudio(true);
      } catch {
        setSendError("Microphone permission is required for voice notes.");
      }
      return;
    }

    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecordingAudio(false);
  };

  const handleDeleteMessage = async (messageId: Id<"messages">) => {
    await deleteOwnMessage({ messageId });
  };

  const handleStartEdit = (message: MessageRow) => {
    setEditingMessageId(message._id);
    setEditingBody(message.body);
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId) {
      return;
    }

    await editOwnMessage({
      messageId: editingMessageId,
      body: editingBody,
    });
    setEditingMessageId(null);
    setEditingBody("");
  };

  const handleToggleStar = async (messageId: Id<"messages">) => {
    await toggleStar({ messageId });
  };

  const handleDeleteConversation = async () => {
    if (!selectedConversationId) {
      return;
    }

    try {
      await deleteConversationForMe({ conversationId: selectedConversationId });
      selectConversation(null);
    } catch {
      setSendError("Could not delete chat. Please try again.");
    }
  };

  const handleToggleBlock = async (targetUserId: Id<"users">) => {
    await toggleBlockUser({ targetUserId });
    if (selectedConversation && selectedConversation.otherUserId === targetUserId) {
      selectConversation(null);
    }
  };

  const handleToggleReaction = async (
    messageId: Id<"messages">,
    emoji: (typeof REACTIONS)[number],
  ) => {
    await toggleReaction({ messageId, emoji });
  };

  const handleAddGroupMembers = async () => {
    if (!selectedConversationId || newGroupMembers.length === 0) {
      return;
    }

    await addGroupMembers({
      conversationId: selectedConversationId,
      memberIds: newGroupMembers,
    });
    setNewGroupMembers([]);
  };

  const handleToggleNewGroupMember = (userId: Id<"users">) => {
    setNewGroupMembers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    );
  };

  const handleRemoveGroupMember = async (userId: Id<"users">) => {
    if (!selectedConversationId) {
      return;
    }

    await removeGroupMember({
      conversationId: selectedConversationId,
      targetUserId: userId,
    });
  };

  const handleRoleChange = async (
    userId: Id<"users">,
    role: "admin" | "member",
  ) => {
    if (!selectedConversationId) {
      return;
    }

    await updateGroupMemberRole({
      conversationId: selectedConversationId,
      targetUserId: userId,
      role,
    });
  };

  const handleToggleReadReceipts = async () => {
    if (!myPrivacy) {
      return;
    }

    await updateMyPrivacySettings({
      readReceiptsEnabled: !myPrivacy.readReceiptsEnabled,
    });
  };

  const handleUpdateLastSeenVisibility = async (value: "everyone" | "nobody") => {
    await updateMyPrivacySettings({
      lastSeenVisibility: value,
    });
  };

  const handleUpdateWhoCanMessage = async (value: "everyone" | "nobody") => {
    await updateMyPrivacySettings({
      whoCanMessage: value,
    });
  };

  const handleToggleLoginAlerts = async () => {
    if (!mySecurity) {
      return;
    }

    await updateMySecuritySettings({
      suspiciousLoginAlerts: !mySecurity.suspiciousLoginAlerts,
    });
  };

  const handleToggleE2EE = async () => {
    if (!mySecurity) {
      return;
    }

    await updateMySecuritySettings({
      e2eeEnabled: !mySecurity.e2eeEnabled,
    });
  };

  const handleSetAudioPlaybackRate = (rate: number) => {
    setAudioPlaybackRate(rate);
    const node = messageListRef.current;
    if (!node) {
      return;
    }
    node.querySelectorAll("audio").forEach((audioElement) => {
      const element = audioElement as HTMLAudioElement;
      element.playbackRate = rate;
    });
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

    if (
      node.scrollTop < 80 &&
      hasMoreHistory &&
      requestedOlderCursor === null &&
      oldestLoadedCreatedAt !== null
    ) {
      setRequestedOlderCursor(oldestLoadedCreatedAt);
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

  const scrollToMessage = (messageId: Id<"messages">) => {
    const node = messageNodeRefs.current[messageId as string];
    if (!node) {
      return;
    }

    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(messageId);
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
          <div className="flex items-center gap-2 sm:gap-3">
            <div ref={headerMenuRef} className="relative order-3 sm:order-1">
              <button
                type="button"
                onClick={() => setShowHeaderMenu((prev) => !prev)}
                className="rounded-md border border-zinc-300 p-2 text-zinc-700 hover:bg-zinc-100"
                aria-label="Open menu"
                title="More options"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-5 w-5"
                >
                  <circle cx="12" cy="5" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="12" cy="19" r="1.8" />
                </svg>
              </button>
              {showHeaderMenu && (
                <div className="absolute right-0 z-20 mt-1 w-[min(22rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 text-zinc-900 shadow-sm">
                  <div className="border-b border-zinc-200 pb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-900">
                      🚫 Blocked users
                    </h3>
                    {blockedUsers === undefined ? (
                      <div className="mt-2 h-8 animate-pulse rounded-md bg-zinc-100" />
                    ) : blockedUsers.length === 0 ? (
                      <p className="mt-2 text-xs text-zinc-900">No blocked users.</p>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {blockedUsers.map((blockedUser) => (
                          <div
                            key={`menu-blocked-${blockedUser._id}`}
                            className="flex items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-zinc-100"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Avatar
                                name={blockedUser.name}
                                imageUrl={blockedUser.imageUrl}
                                size="sm"
                              />
                              <span className="truncate">{blockedUser.name}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleToggleBlock(blockedUser._id)}
                              className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-900 hover:bg-zinc-100"
                            >
                              Unblock
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 border-b border-zinc-200 pb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-900">
                      🔎 Global search
                    </h3>
                    <input
                      ref={globalSearchInputRef}
                      value={globalSearch}
                      onChange={(event) => setGlobalSearch(event.target.value)}
                      placeholder="Search all chats"
                      className="mt-2 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900 outline-none ring-zinc-300 focus:ring"
                    />
                    <p className="mt-1 text-[10px] text-zinc-900">Shortcut: Ctrl/Cmd + K</p>
                    <select
                      value={searchMediaType}
                      onChange={(event) =>
                        setSearchMediaType(
                          event.target.value as "all" | "image" | "video" | "audio",
                        )
                      }
                      className="mt-2 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900"
                    >
                      <option value="all">All media</option>
                      <option value="image">Images only</option>
                      <option value="video">Videos only</option>
                      <option value="audio">Audio only</option>
                    </select>
                    <select
                      value={globalSenderId}
                      onChange={(event) =>
                        setGlobalSenderId(
                          event.target.value === "all"
                            ? "all"
                            : (event.target.value as Id<"users">),
                        )
                      }
                      className="mt-2 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900"
                    >
                      <option value="all">All senders</option>
                      {globalSenderOptions.map((row) => (
                        <option key={`menu-global-sender-${row.userId}`} value={row.userId}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        value={globalFromDate}
                        onChange={(event) => setGlobalFromDate(event.target.value)}
                        className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900"
                      />
                      <input
                        type="date"
                        value={globalToDate}
                        onChange={(event) => setGlobalToDate(event.target.value)}
                        className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900"
                      />
                    </div>
                    {globalSearchResults && globalSearchResults.length > 0 && (
                      <div className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                        {globalSearchResults.slice(0, 8).map((row) => (
                          <button
                            key={`menu-global-${row.messageId}`}
                            type="button"
                            onClick={() => {
                              setShowHeaderMenu(false);
                              selectConversation(row.conversationId);
                            }}
                            className="w-full rounded-md border border-zinc-200 px-2 py-1 text-left text-[11px] hover:bg-zinc-50"
                          >
                            <p className="truncate font-medium">{row.conversationTitle}</p>
                            <p className="truncate text-zinc-900">
                              {row.body ||
                                (row.mediaType === "image"
                                  ? "📷 Photo"
                                  : row.mediaType === "video"
                                    ? "🎬 Video"
                                    : row.mediaType === "audio"
                                      ? "🎤 Voice"
                                      : "Message")}
                            </p>
                          </button>
                        ))}
                      </div>
                    )}
                    {globalSearch.trim().length > 0 &&
                      globalSearchResults !== undefined &&
                      globalSearchResults.length === 0 && (
                        <p className="mt-2 text-xs text-zinc-900">
                          No global results for current filters.
                        </p>
                      )}
                  </div>

                  <div className="mt-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-900">
                      🔐 Privacy & security
                    </h3>
                    <div className="mt-2 space-y-1 text-xs">
                      <button
                        type="button"
                        onClick={() => void handleToggleReadReceipts()}
                        className="w-full rounded-md border border-zinc-300 px-2 py-1 text-left text-zinc-900 hover:bg-zinc-100"
                      >
                        Read receipts: {myPrivacy?.readReceiptsEnabled ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleToggleLoginAlerts()}
                        className="w-full rounded-md border border-zinc-300 px-2 py-1 text-left text-zinc-900 hover:bg-zinc-100"
                      >
                        Suspicious login alerts: {mySecurity?.suspiciousLoginAlerts ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleToggleE2EE()}
                        className="w-full rounded-md border border-zinc-300 px-2 py-1 text-left text-zinc-900 hover:bg-zinc-100"
                      >
                        E2EE mode (scaffold): {mySecurity?.e2eeEnabled ? "On" : "Off"}
                      </button>
                      <label className="block rounded-md border border-zinc-300 px-2 py-1">
                        <span className="text-zinc-900">Last seen visibility</span>
                        <select
                          value={myPrivacy?.lastSeenVisibility ?? "everyone"}
                          onChange={(event) =>
                            void handleUpdateLastSeenVisibility(
                              event.target.value as "everyone" | "nobody",
                            )
                          }
                          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                        >
                          <option value="everyone">Everyone</option>
                          <option value="nobody">Nobody</option>
                        </select>
                      </label>
                      <label className="block rounded-md border border-zinc-300 px-2 py-1">
                        <span className="text-zinc-900">Who can message me</span>
                        <select
                          value={myPrivacy?.whoCanMessage ?? "everyone"}
                          onChange={(event) =>
                            void handleUpdateWhoCanMessage(
                              event.target.value as "everyone" | "nobody",
                            )
                          }
                          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-zinc-900"
                        >
                          <option value="everyone">Everyone</option>
                          <option value="nobody">Nobody</option>
                        </select>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="order-1 sm:order-2">
              <UserButton />
            </div>
            <div className="order-2 sm:order-3">
              <SignOutButton>
                <button className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
                  Log out
                </button>
              </SignOutButton>
            </div>
          </div>
        </header>

        <main className="flex h-[calc(100dvh-3.5rem)] overflow-hidden">
          <aside
            className={`${
              selectedConversationId ? "hidden md:flex" : "flex"
            } w-full shrink-0 flex-col border-r border-zinc-200 bg-white md:w-80 lg:w-96`}
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
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar name={chatUser.name} imageUrl={chatUser.imageUrl} size="sm" />
                          <span className="truncate">{chatUser.name}</span>
                        </span>
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
                      <div
                        key={chatUser._id}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100"
                      >
                        <button
                          type="button"
                          onClick={() => void handleSelectUser(chatUser._id)}
                          className="flex min-w-0 flex-1 items-center gap-2"
                        >
                          <Avatar name={chatUser.name} imageUrl={chatUser.imageUrl} size="sm" />
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              chatUser.isOnline ? "bg-green-500" : "bg-zinc-300"
                            }`}
                          />
                          <span className="truncate">{chatUser.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleBlock(chatUser._id)}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100"
                        >
                          Block
                        </button>
                      </div>
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
                        <div className="flex min-w-0 items-center gap-2">
                          <Avatar
                            name={conversation.title}
                            imageUrl={conversation.imageUrl}
                            size="sm"
                          />
                          <p className="truncate text-sm font-medium text-zinc-900">
                            {conversation.title}
                            {conversation.isGroup
                              ? ` (${conversation.memberCount})`
                              : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {conversation.unreadCount > 0 && (
                            <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] text-white">
                              {conversation.unreadCount}
                            </span>
                          )}
                          {conversation.lastMessageAt && (
                            <p className="hidden shrink-0 text-xs text-zinc-500 sm:block">
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
            } min-w-0 flex-1 flex-col`}
          >
            {!selectedConversationId ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-zinc-500">
                Select a conversation from the sidebar to start messaging.
              </div>
            ) : (
              <>
                <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 sm:px-4">
                  <button
                    onClick={() => selectConversation(null)}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 md:hidden"
                  >
                    Back
                  </button>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {selectedConversation && (
                        <Avatar
                          name={selectedConversation.title}
                          imageUrl={selectedConversation.imageUrl}
                          size="sm"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-900">
                          {selectedConversation?.title ?? "Loading..."}
                        </p>
                        {selectedConversation?.isGroup && (
                          <p className="text-xs text-zinc-500">
                            {selectedConversation.memberCount} members
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {selectedConversation?.isGroup && (
                        <button
                          type="button"
                          onClick={() => setShowGroupPanel((prev) => !prev)}
                          className="whitespace-nowrap rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                        >
                          {showGroupPanel ? (
                            <>
                              <span className="sm:hidden">Group</span>
                              <span className="hidden sm:inline">Close group</span>
                            </>
                          ) : (
                            <>
                              <span className="sm:hidden">Group</span>
                              <span className="hidden sm:inline">Manage group</span>
                            </>
                          )}
                        </button>
                      )}
                      {!selectedConversation?.isGroup && selectedConversation?.otherUserId && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!selectedConversation?.otherUserId) {
                              return;
                            }
                            void handleToggleBlock(selectedConversation.otherUserId);
                          }}
                          className="whitespace-nowrap rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                        >
                          Block
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDeleteConversation()}
                        className="whitespace-nowrap rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                      >
                        <span className="sm:hidden">Delete</span>
                        <span className="hidden sm:inline">Delete chat</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="relative flex-1 overflow-hidden">
                  <div className="border-b border-zinc-200 bg-white px-4 py-2">
                    {historyMessageId && (
                      <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="font-medium text-zinc-700">Edit history</p>
                          <button
                            type="button"
                            onClick={() => setHistoryMessageId(null)}
                            className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100"
                          >
                            Close
                          </button>
                        </div>
                        <div className="max-h-24 space-y-1 overflow-y-auto">
                          {editHistory === undefined ? (
                            <p className="text-zinc-500">Loading history...</p>
                          ) : editHistory.length === 0 ? (
                            <p className="text-zinc-500">No previous edits found.</p>
                          ) : (
                            editHistory.map((entry) => (
                              <div
                                key={`edit-${entry._id}`}
                                className="rounded border border-zinc-200 bg-white px-2 py-1"
                              >
                                <p className="truncate text-zinc-700">{entry.previousBody || "(empty)"}</p>
                                <p className="text-[10px] text-zinc-500">
                                  {formatTimestamp(entry.editedAt)}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                    {conversationSearchResults && conversationSearchResults.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {conversationSearchResults.slice(0, 8).map((row) => (
                          <button
                            key={`conv-search-${row.messageId}`}
                            type="button"
                            onClick={() => scrollToMessage(row.messageId)}
                            className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100"
                          >
                            {row.body ||
                              (row.mediaType === "image"
                                ? "📷 Photo"
                                : row.mediaType === "video"
                                  ? "🎬 Video"
                                  : row.mediaType === "audio"
                                    ? "🎤 Voice"
                                  : "Message")}
                          </button>
                        ))}
                      </div>
                    )}
                    {conversationSearch.trim().length > 0 &&
                      conversationSearchResults !== undefined &&
                      conversationSearchResults.length === 0 && (
                        <p className="mt-2 text-xs text-zinc-500">
                          No messages match these chat search filters.
                        </p>
                      )}
                    {starredMessages && starredMessages.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {starredMessages.slice(0, 6).map((row) => (
                          <button
                            key={`star-${row.messageId}`}
                            type="button"
                            onClick={() => scrollToMessage(row.messageId)}
                            className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] text-zinc-700 hover:bg-zinc-100"
                          >
                            ⭐ {row.body ||
                              (row.mediaType === "image"
                                ? "Photo"
                                : row.mediaType === "video"
                                  ? "Video"
                                  : row.mediaType === "audio"
                                    ? "Voice"
                                    : "Message")}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {showGroupPanel && selectedConversation?.isGroup && (
                    <div className="border-b border-zinc-200 bg-white px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Group management ({selectedConversation.myRole ?? "member"})
                      </p>
                      <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                        {groupMembers?.map((member) => (
                          <div
                            key={`group-member-${member.userId}`}
                            className="flex items-center justify-between rounded-md border border-zinc-200 px-2 py-1 text-xs"
                          >
                            <span className="truncate">{member.name} ({member.role})</span>
                            <div className="flex items-center gap-1">
                              {selectedConversation.myRole === "owner" && member.role !== "owner" && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleRoleChange(
                                      member.userId,
                                      member.role === "admin" ? "member" : "admin",
                                    )
                                  }
                                  className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] hover:bg-zinc-100"
                                >
                                  {member.role === "admin" ? "Make member" : "Make admin"}
                                </button>
                              )}
                              {(selectedConversation.myRole === "owner" ||
                                selectedConversation.myRole === "admin") &&
                                member.role !== "owner" && (
                                  <button
                                    type="button"
                                    onClick={() => void handleRemoveGroupMember(member.userId)}
                                    className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] hover:bg-zinc-100"
                                  >
                                    Remove
                                  </button>
                                )}
                            </div>
                          </div>
                        ))}
                        {groupMembers !== undefined && groupMembers.length === 0 && (
                          <p className="text-xs text-zinc-500">No active members found.</p>
                        )}
                      </div>
                      {(selectedConversation.myRole === "owner" ||
                        selectedConversation.myRole === "admin") && (
                        <div className="mt-2">
                          <div className="max-h-24 space-y-1 overflow-y-auto">
                            {users
                              ?.filter(
                                (chatUser) =>
                                  !groupMembers?.some(
                                    (member) => member.userId === chatUser._id,
                                  ),
                              )
                              .map((chatUser) => (
                                <label
                                  key={`add-member-${chatUser._id}`}
                                  className="flex items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-zinc-100"
                                >
                                  <span className="truncate">{chatUser.name}</span>
                                  <input
                                    type="checkbox"
                                    checked={newGroupMembers.includes(chatUser._id)}
                                    onChange={() => handleToggleNewGroupMember(chatUser._id)}
                                  />
                                </label>
                              ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleAddGroupMembers()}
                            className="mt-2 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                          >
                            Add selected members
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div
                    ref={messageListRef}
                    onScroll={onMessageListScroll}
                    className="h-full space-y-3 overflow-y-auto p-4"
                  >
                    {requestedOlderCursor !== null && (
                      <p className="text-center text-xs text-zinc-500">Loading older messages…</p>
                    )}
                    {isMessagesLoading ? (
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
                        const isUnavailableReply =
                          message.replyTo?.body === "Original message unavailable";
                        const isDeletedReply =
                          message.replyTo?.body === "This message was deleted";

                        return (
                          <div
                            key={message._id}
                            className={`flex ${
                              message.isOwn ? "justify-end" : "justify-start"
                            }`}
                          >
                            <div className="flex max-w-[90%] items-start gap-2">
                              {!message.isOwn && (
                                <Avatar
                                  name={message.senderName}
                                  imageUrl={message.senderImageUrl}
                                  size="sm"
                                />
                              )}
                              <div
                                ref={(node) => {
                                  messageNodeRefs.current[message._id as string] = node;
                                }}
                                className={`rounded-lg px-3 py-2 ${
                                  message.isOwn
                                    ? "bg-zinc-900 text-white"
                                    : "border border-zinc-200 bg-white text-zinc-900"
                                } ${
                                  highlightedMessageId === message._id
                                    ? "ring-2 ring-zinc-400"
                                    : ""
                                }`}
                              >
                              <div className="flex items-start justify-between gap-3">
                                <p className="text-xs opacity-75">{message.senderName}</p>
                                {!message.deleted && (
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() =>
                                        setReplyToMessage({
                                          messageId: message._id,
                                          senderName: message.senderName,
                                          body: message.body,
                                          mediaType: message.mediaType,
                                        })
                                      }
                                      className="text-[10px] opacity-70 hover:opacity-100"
                                    >
                                      Reply
                                    </button>
                                    <button
                                      onClick={() => void handleToggleStar(message._id)}
                                      className="text-[10px] opacity-70 hover:opacity-100"
                                    >
                                      {message.isStarred ? "Unstar" : "Star"}
                                    </button>
                                    {message.isOwn && (
                                      <button
                                        onClick={() => handleStartEdit(message)}
                                        className="text-[10px] opacity-70 hover:opacity-100"
                                      >
                                        Edit
                                      </button>
                                    )}
                                    {(message.editCount ?? 0) > 0 && (
                                      <button
                                        onClick={() => setHistoryMessageId(message._id)}
                                        className="text-[10px] opacity-70 hover:opacity-100"
                                      >
                                        History
                                      </button>
                                    )}
                                    {message.isOwn && (
                                      <button
                                        onClick={() => handleDeleteMessage(message._id)}
                                        className="text-[10px] opacity-70 hover:opacity-100"
                                      >
                                        Delete
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>

                              {message.deleted ? (
                                <p className="text-sm italic opacity-75">
                                  This message was deleted
                                </p>
                              ) : (
                                <>
                                  {message.replyTo && (
                                    <button
                                      type="button"
                                      onClick={() => scrollToMessage(message.replyTo!.messageId)}
                                      className={`mb-2 w-full rounded-md border px-2 py-1 text-left text-xs ${
                                        isUnavailableReply || isDeletedReply
                                          ? "border-amber-300/70 bg-amber-50 text-amber-800"
                                          : "border-zinc-300/40 bg-black/5"
                                      }`}
                                    >
                                      <p className="font-medium">{message.replyTo.senderName}</p>
                                      <p className="truncate opacity-80">
                                        {message.replyTo.body ||
                                          (message.replyTo.mediaType === "image"
                                            ? "📷 Photo"
                                            : message.replyTo.mediaType === "video"
                                              ? "🎬 Video"
                                              : message.replyTo.mediaType === "audio"
                                                ? "🎤 Voice"
                                              : "Message")}
                                      </p>
                                    </button>
                                  )}
                                  {message.mediaType === "image" && message.mediaUrl && (
                                    <Image
                                      src={message.mediaUrl}
                                      alt="Shared image"
                                      width={640}
                                      height={480}
                                      unoptimized
                                      className="mb-2 h-auto max-h-80 w-auto max-w-full rounded-md object-contain"
                                    />
                                  )}
                                  {message.mediaType === "video" && message.mediaUrl && (
                                    <video
                                      controls
                                      preload="metadata"
                                      className="mb-2 max-h-80 max-w-full rounded-md"
                                      src={message.mediaUrl}
                                    />
                                  )}
                                  {message.mediaType === "audio" && message.mediaUrl && (
                                    <div className="mb-2 space-y-1">
                                      <audio
                                        controls
                                        preload="metadata"
                                        src={message.mediaUrl}
                                        onLoadedMetadata={(event) => {
                                          event.currentTarget.playbackRate = audioPlaybackRate;
                                        }}
                                        className="w-full"
                                      />
                                      <div className="flex items-center gap-1 text-[10px]">
                                        {[1, 1.25, 1.5, 2].map((rate) => (
                                          <button
                                            key={`${message._id}-rate-${rate}`}
                                            type="button"
                                            onClick={() => handleSetAudioPlaybackRate(rate)}
                                            className={`rounded border px-1.5 py-0.5 ${
                                              audioPlaybackRate === rate
                                                ? "border-zinc-900"
                                                : "border-zinc-300"
                                            }`}
                                          >
                                            {rate}x
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {editingMessageId === message._id ? (
                                    <div className="space-y-2">
                                      <input
                                        value={editingBody}
                                        onChange={(event) => setEditingBody(event.target.value)}
                                        className="w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-900"
                                      />
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => void handleSaveEdit()}
                                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100"
                                        >
                                          Save
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingMessageId(null);
                                            setEditingBody("");
                                          }}
                                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    message.body && <p className="text-sm">{message.body}</p>
                                  )}
                                </>
                              )}

                              <p className="mt-1 text-[11px] opacity-75">
                                {formatTimestamp(message.createdAt)}
                                {message.editedAt ? " • edited" : ""}
                              </p>

                              {message.isOwn && message.status && (
                                <p className="mt-1 text-[10px] opacity-70">
                                  {message.status === "sent"
                                    ? "✓ Sent"
                                    : message.status === "delivered"
                                      ? "✓✓ Delivered"
                                      : "✓✓ Read"}
                                  {message.seenBy && message.seenBy.length > 0
                                    ? ` • Seen by ${message.seenBy
                                        .slice(0, 3)
                                        .map((row) => row.name)
                                        .join(", ")}`
                                    : ""}
                                </p>
                              )}

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
                  {replyToMessage && (
                    <div className="mb-2 flex items-start justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                      <div className="min-w-0 text-xs text-zinc-600">
                        <p className="font-medium text-zinc-800">
                          Replying to {replyToMessage.senderName}
                        </p>
                        <p
                          className={`truncate ${
                            replyToMessage.body === "Original message unavailable" ||
                            replyToMessage.body === "This message was deleted"
                              ? "text-amber-700"
                              : ""
                          }`}
                        >
                          {replyToMessage.body ||
                            (replyToMessage.mediaType === "image"
                              ? "📷 Photo"
                              : replyToMessage.mediaType === "video"
                                ? "🎬 Video"
                                : replyToMessage.mediaType === "audio"
                                  ? "🎤 Voice"
                                : "Message")}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setReplyToMessage(null)}
                        className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,video/*,audio/*"
                      onChange={(event) => {
                        void handlePickMedia(event);
                      }}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!selectedConversationId}
                      className="rounded-md border border-zinc-300 px-2.5 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Media
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleRecording()}
                      title={isRecordingAudio ? "Stop recording" : "Start recording"}
                      aria-label={isRecordingAudio ? "Stop recording" : "Start recording"}
                      className={`rounded-md border p-2 ${
                        isRecordingAudio
                          ? "border-red-400 text-red-600"
                          : "border-zinc-300 text-zinc-700 hover:bg-zinc-100"
                      }`}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`h-5 w-5 ${isRecordingAudio ? "animate-pulse" : ""}`}
                      >
                        <rect x="9" y="2" width="6" height="12" rx="3" ry="3" />
                        <path d="M5 10a7 7 0 0 0 14 0" />
                        <line x1="12" y1="17" x2="12" y2="22" />
                        <line x1="8" y1="22" x2="16" y2="22" />
                      </svg>
                    </button>
                    <input
                      value={draftMessage}
                      onChange={(event) => setDraftMessage(event.target.value)}
                      placeholder="Type a message or send media"
                      className="order-3 basis-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none ring-zinc-300 focus:ring sm:order-none sm:basis-auto sm:flex-1"
                    />
                    <button
                      type="submit"
                      disabled={isUploadingMedia}
                      className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800"
                    >
                      Send
                    </button>
                  </div>
                  {isRecordingAudio && (
                    <div className="mt-2 flex h-8 items-end gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1">
                      {(recordingWaveform.length > 0 ? recordingWaveform : [12, 18, 14, 20]).map(
                        (value, index) => (
                          <div
                            key={`wave-${index}`}
                            className="w-1 rounded bg-red-500"
                            style={{ height: `${value}%` }}
                          />
                        ),
                      )}
                    </div>
                  )}
                  {uploadQueue.length > 0 && (
                    <div className="mt-2 rounded-md border border-zinc-200 p-2 text-xs">
                      <div className="mb-2 flex items-center justify-between text-zinc-600">
                        <p>Upload queue ({uploadQueue.length})</p>
                        <button
                          type="button"
                          onClick={handleClearUploadQueue}
                          className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100"
                        >
                          Clear done/failed
                        </button>
                      </div>
                      <div className="max-h-28 space-y-2 overflow-y-auto">
                        {uploadQueue.map((item) => (
                          <div key={`queue-${item.id}`} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-zinc-600">
                              <p className="truncate">
                                {item.status === "uploading"
                                  ? "Uploading"
                                  : item.status === "queued"
                                    ? "Queued"
                                    : item.status === "completed"
                                      ? "Completed"
                                      : "Failed"}
                                : {item.file.name} ({item.progress}%)
                              </p>
                              <div className="flex items-center gap-1">
                                {item.status === "failed" && (
                                  <button
                                    type="button"
                                    onClick={() => handleRetryUpload(item.id)}
                                    className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100"
                                  >
                                    Retry
                                  </button>
                                )}
                                {(item.status === "failed" || item.status === "completed") && (
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveUploadItem(item.id)}
                                    className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100"
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="h-1.5 w-full rounded bg-zinc-200">
                              <div
                                className={`h-1.5 rounded ${
                                  item.status === "failed"
                                    ? "bg-red-500"
                                    : item.status === "completed"
                                      ? "bg-green-500"
                                      : "bg-zinc-500"
                                }`}
                                style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
                              />
                            </div>
                            {item.error && <p className="text-red-600">{item.error}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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
