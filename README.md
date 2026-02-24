# Livechat (Next.js + TypeScript + Convex + Clerk)

A real-time one-on-one chat app where users can sign up, discover other users, and exchange live messages.

## Tech Stack

- Next.js (App Router)
- TypeScript
- Convex (database + realtime backend)
- Clerk (authentication)
- Tailwind CSS

## Implemented Features (Required 1-6)

1. Authentication with Clerk (sign up / sign in / sign out)
2. User discovery and live name search
3. Private direct conversations with real-time message updates
4. Challenge-compliant timestamp formatting
5. Empty states for no conversations, no messages, and no search results
6. Responsive layout (desktop split view, mobile full-screen chat with back button)

## Project Structure

- `app/page.tsx`: Main chat UI and responsive behavior
- `app/providers.tsx`: Clerk + Convex providers
- `convex/schema.ts`: Convex tables and indexes
- `convex/users.ts`: User sync + user search queries
- `convex/conversations.ts`: Conversation list + open/create direct conversation
- `convex/messages.ts`: Real-time message list + send mutation
- `lib/formatTimestamp.ts`: Timestamp formatting rules
- `VIDEO_PRESENTATION_SCRIPT.md`: 2-3 minute demo script

## Environment Variables

Copy `.env.example` into `.env.local` and fill values:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_JWT_ISSUER_DOMAIN`
- `NEXT_PUBLIC_CONVEX_URL`

For local Convex, run:

```bash
npx convex dev
```

This generates/updates local Convex env values and keeps backend functions synced.

## Run Locally

1. Install dependencies

```bash
npm install
```

2. Start Convex (in one terminal)

```bash
npx convex dev
```

3. Start Next.js (in another terminal)

```bash
npm run dev
```

4. Open `http://localhost:3000`

## Notes

- If Clerk keys are not configured, the app shows a setup message on `/`.
- Convex generated files are in `convex/_generated`.
