# AdaptlyPost API Reference

Base URL: `https://post.adaptlypost.com/post/api/v1`
Auth: `Authorization: Bearer <api-token>` header. Tokens start with the `adaptly_` prefix.

The same header also accepts a WorkOS OAuth access token, which is how the hosted MCP server authenticates. For a skill, use an `adaptly_` token.

## Endpoints

### GET /social-accounts

List all connected social media accounts for the account group tied to this API token.

**Response:**

```json
{
  "accounts": [
    {
      "id": "cmlxmnxn20006hzpzvo291ckg",
      "platform": "INSTAGRAM",
      "displayName": "John Doe",
      "username": "johndoe",
      "avatarUrl": "https://..."
    },
    {
      "id": "cmlxmnxn20006hzpzvo291abc",
      "platform": "FACEBOOK",
      "displayName": "My Business Page",
      "username": "",
      "avatarUrl": "",
      "pageId": "123456789012345"
    }
  ]
}
```

Platform values: `TIKTOK`, `INSTAGRAM`, `FACEBOOK`, `TWITTER`, `YOUTUBE`, `LINKEDIN`, `THREADS`, `BLUESKY`, `PINTEREST`

**Notes:**

- Facebook accounts represent pages, not personal profiles
- For Facebook, the `id` field is what you pass in `pageIds` when creating posts. The extra `pageId` field is the page's public ID on facebook.com — informational only (shown since pages have no `username`), do NOT pass it as an identifier
- LinkedIn and YouTube accounts may have empty `username`
- Bluesky `username` is the handle (e.g., `user.bsky.social`)

### POST /social-posts

Create or schedule a post to one or more social media platforms.

**Request:**

```json
{
  "platforms": ["TWITTER", "INSTAGRAM"],
  "contentType": "IMAGE",
  "text": "Post text with #hashtags",
  "platformTexts": [{ "platform": "TWITTER", "text": "Short version for X" }],
  "mediaUrls": ["https://cdn.adaptlypost.com/social-media-posts/uuid/photo.jpg"],
  "thumbnailUrl": "https://cdn.adaptlypost.com/social-media-posts/uuid/thumb.jpg",
  "scheduledAt": "2026-06-15T10:00:00.000Z",
  "timezone": "America/New_York",
  "saveAsDraft": false,
  "twitterConnectionIds": ["connection-id-1"],
  "instagramConnectionIds": ["connection-id-2"],
  "instagramConfigs": [
    {
      "connectionId": "connection-id-2",
      "postType": "FEED"
    }
  ]
}
```

**Required fields:**

- `platforms` (string[]): At least one platform. Values: `FACEBOOK`, `INSTAGRAM`, `THREADS`, `TIKTOK`, `TWITTER`, `BLUESKY`, `LINKEDIN`, `PINTEREST`, `YOUTUBE`
- `contentType` (string): `TEXT`, `IMAGE`, `VIDEO`, or `CAROUSEL`
- `timezone` (string): IANA timezone string (e.g., `America/New_York`, `Europe/London`). Stored with the post for display; it does not shift `scheduledAt`

**Optional fields:**

- `text` (string): Default post text for all platforms
- `platformTexts` (array): Per-platform text overrides. Each: `{ "platform": "TWITTER", "text": "..." }`
- `mediaUrls` (string[]): Public URLs of uploaded media files
- `thumbnailUrl` (string): Thumbnail URL for video posts
- `scheduledAt` (string): ISO 8601 UTC datetime. A future value schedules the post; omitted or in the past publishes immediately
- `saveAsDraft` (boolean): Save as `DRAFT` instead of scheduling/publishing; validation is deferred to `POST /social-posts/:id/publish`
- `pageIds` (string[]): Facebook page account `id` values from `/social-accounts` (not the `pageId` field)
- `tiktokConnectionIds` (string[]): TikTok account connection IDs
- `threadsConnectionIds` (string[]): Threads account connection IDs
- `instagramConnectionIds` (string[]): Instagram account connection IDs
- `twitterConnectionIds` (string[]): X/Twitter account connection IDs
- `blueskyConnectionIds` (string[]): Bluesky account connection IDs
- `linkedinConnectionIds` (string[]): LinkedIn account connection IDs
- `pinterestConnectionIds` (string[]): Pinterest account connection IDs
- `youtubeConnectionIds` (string[]): YouTube account connection IDs
- `pinterestConfigs` (array): Pinterest-specific settings per connection
- `tiktokConfigs` (array): TikTok-specific settings per connection
- `instagramConfigs` (array): Instagram-specific settings per connection
- `facebookConfigs` (array): Facebook-specific settings per page
- `youtubeConfigs` (array): YouTube-specific settings per connection

See [platform-configs.md](platform-configs.md) for detailed config schemas.

**Response:**

```json
{
  "postId": "cmm0z0k3q0000i0r5mxn0hfhs",
  "queuedPlatforms": ["TWITTER", "INSTAGRAM"],
  "skippedPlatforms": [
    {
      "platform": "FACEBOOK",
      "reason": "No valid connection found"
    }
  ],
  "isScheduled": true,
  "scheduledAt": "2026-06-15T10:00:00.000Z"
}
```

`queuedPlatforms` confirms that publishing jobs were queued, not that they succeeded: each platform publishes asynchronously and on its own, so read `GET /social-posts/:id/results` for the outcome. A future `scheduledAt` returns `isScheduled: true` with status `SCHEDULED`; a missing or past `scheduledAt` publishes immediately with status `PENDING`; `saveAsDraft: true` stores a `DRAFT`.

### GET /social-posts

List every post in the authenticated account group, any status, with pagination. Newest first by default.

**Query parameters:**

- `limit` (integer, optional): Number of posts to return. Range: 1-100. Default: 20
- `offset` (integer, optional): Number of posts to skip. Min: 0. Default: 0
- `sortOrder` (string, optional): `NEWEST` or `OLDEST`. Default: `NEWEST`
- `statuses` (PostStatus[], optional): Filter by one or more post statuses. Repeat the key per value.
- `platforms` (PlatformType[], optional): Filter by one or more platforms. Repeat the key per value.
- `startDate` (string, optional): Lower bound on `scheduledAt`, or on `createdAt` for posts that were never scheduled (ISO 8601, e.g. `2026-07-20`).
- `endDate` (string, optional): Upper bound on `scheduledAt`, or on `createdAt` for posts that were never scheduled (ISO 8601, e.g. `2026-07-22`).

Array filters (`statuses`, `platforms`) are sent as repeated keys, e.g. `platforms=FACEBOOK&platforms=TIKTOK`.

**Example:**

```
GET /social-posts?limit=10&offset=0&statuses=SCHEDULED&statuses=PUBLISHING&platforms=FACEBOOK
```

**Response:**

```json
{
  "posts": [
    {
      "id": "cmm0z0k3q0000i0r5mxn0hfhs",
      "createdAt": "2026-02-24T19:00:34.114Z",
      "updatedAt": "2026-02-24T19:00:34.114Z",
      "userId": "user_01KH48SNHMPJNFYPJWZVJAKXDS",
      "contentType": "TEXT",
      "text": "Hello from API!",
      "scheduledAt": "2026-06-15T10:00:00.000Z",
      "timezone": "America/New_York",
      "status": "DRAFT",
      "platforms": [
        {
          "id": "cmm0z0k3u0001i0r5dlbfa440",
          "createdAt": "2026-02-24T19:00:34.114Z",
          "updatedAt": "2026-02-24T19:00:34.114Z",
          "platform": "TWITTER",
          "status": "PENDING",
          "connectionId": "cmlxly42t0004hzq1bh9kqpwl",
          "mediaUrls": [],
          "youtubeTags": []
        }
      ]
    }
  ],
  "total": 1,
  "hasMore": false
}
```

**Post status values:** `DRAFT`, `SCHEDULED`, `PENDING`, `PUBLISHING`, `COMPLETED`, `PARTIAL_FAILURE`, `FAILED`
**Platform status values:** `PENDING`, `PUBLISHING`, `PUBLISHED`, `FAILED`

### GET /social-posts/:id

Get a single post by ID. Returns 404 if not found or not in the account group.

**Response:**
Same structure as individual post in the list endpoint.

**Error response (404):**

```json
{
  "message": "Post not found or access denied",
  "error": "Not Found",
  "statusCode": 404
}
```

### POST /social-posts/bulk

Schedule up to 100 posts at once. Each post can have its own content, media, and scheduled time.

**Request:**

```json
{
  "platforms": ["YOUTUBE", "PINTEREST"],
  "timezone": "America/New_York",
  "youtubeConnectionIds": ["conn_yt123"],
  "pinterestConnectionIds": ["conn_pin456"],
  "youtubeConfigs": [{ "connectionId": "conn_yt123", "postType": "SHORTS", "privacyStatus": "public" }],
  "pinterestConfigs": [{ "connectionId": "conn_pin456", "boardId": "board_abc", "title": "Default title" }],
  "posts": [
    {
      "contentType": "VIDEO",
      "text": "First video",
      "mediaUrls": ["https://cdn.adaptlypost.com/uploads/video1.mp4"],
      "scheduledAt": "2026-03-15T10:00:00Z"
    },
    {
      "contentType": "VIDEO",
      "text": "Second video with custom YouTube config",
      "mediaUrls": ["https://cdn.adaptlypost.com/uploads/video2.mp4"],
      "scheduledAt": "2026-03-15T14:00:00Z",
      "youtubeConfigs": [{ "connectionId": "conn_yt123", "postType": "VIDEO", "videoTitle": "Full tutorial", "privacyStatus": "unlisted" }]
    }
  ]
}
```

**Required fields:**

- `platforms` (string[]): At least one platform
- `timezone` (string): IANA timezone string
- `posts` (array): 1-100 post items

**Optional fields (batch-level):**

- Connection ID arrays: `twitterConnectionIds`, `linkedinConnectionIds`, `instagramConnectionIds`, `tiktokConnectionIds`, `youtubeConnectionIds`, `pinterestConnectionIds`, `blueskyConnectionIds`, `threadsConnectionIds`, `pageIds`
- Platform configs (applied to all posts as default): `pinterestConfigs`, `tiktokConfigs`, `instagramConfigs`, `facebookConfigs`, `youtubeConfigs`

See [platform-configs.md](platform-configs.md) for config schemas.

**Post item fields:**

- `contentType` (string, required): `TEXT`, `IMAGE`, `VIDEO`, or `CAROUSEL`
- `scheduledAt` (string, required): ISO 8601 UTC datetime
- `text` (string): Post text
- `platformTexts` (array): Per-platform text overrides
- `mediaUrls` (string[]): Media file URLs
- `thumbnailUrl` (string): Thumbnail URL for video posts
- `thumbnailTimestampMs` (number): Thumbnail position in video (ms)
- Platform config overrides (per-post): `pinterestConfigs`, `tiktokConfigs`, `instagramConfigs`, `facebookConfigs`, `youtubeConfigs` — when set on a post item, these override the batch-level configs for that specific post

**Response:**

```json
{
  "totalScheduled": 2,
  "totalFailed": 0,
  "results": [
    { "postId": "post_abc001", "success": true, "isScheduled": true, "scheduledAt": "2026-03-15T10:00:00Z", "errorMessage": null },
    { "postId": "post_abc002", "success": true, "isScheduled": true, "scheduledAt": "2026-03-15T14:00:00Z", "errorMessage": null }
  ]
}
```

**Notes:**

- Maximum 100 posts per request
- Each post is processed independently — if one fails, others still schedule
- Only one account per platform allowed (platform ToS compliance)
- Per-post platform configs completely replace batch-level configs (no merging)

### POST /upload-urls

Get presigned upload URLs for media files. Upload 1-20 files per request.

**Request:**

```json
{
  "files": [
    { "fileName": "photo.jpg", "mimeType": "image/jpeg" },
    { "fileName": "video.mp4", "mimeType": "video/mp4" }
  ]
}
```

**Supported MIME types:**

- `image/jpeg` — JPEG images
- `image/png` — PNG images
- `image/webp` — WebP images
- `video/mp4` — MP4 video
- `video/quicktime` — MOV video

**Response:**

```json
{
  "urls": [
    {
      "fileName": "photo.jpg",
      "uploadUrl": "https://...presigned-s3-url...",
      "publicUrl": "https://cdn.adaptlypost.com/social-media-posts/uuid/photo.jpg",
      "key": "social-media-posts/uuid/photo.jpg",
      "expiresAt": "2026-02-24T20:00:00.000Z"
    }
  ]
}
```

**Upload flow:**

1. Call this endpoint to get `uploadUrl` and `publicUrl` (this only mints a URL — it does not store a file)
2. PUT the raw file binary to `uploadUrl` with matching `Content-Type` header, and confirm a `2xx` response
3. Use the `publicUrl` in `mediaUrls` when creating a post

> **The file must be uploaded (step 2) before you reference its `publicUrl`.** `POST /social-posts` and `POST /social-posts/bulk` verify every `publicUrl` exists in storage. A URL whose PUT never completed (or whose upload URL expired after 1 hour) is rejected with `400 Bad Request` and `Media file(s) not found in storage: <url>`. In bulk requests this is reported per-post; the remaining posts are still scheduled.

### GET /social-posts/:id/results

Per-platform publishing outcome for one post. Each platform reports on its own, so read this per row rather than treating the post as one pass or fail. Publishing is asynchronous, so poll until no row is `PENDING` or `PUBLISHING`.

**Response:**

```json
{
  "postId": "cmm0z0k3q0000i0r5mxn0hfhs",
  "status": "PARTIAL_FAILURE",
  "results": [
    { "platformId": "pp_abc001", "platform": "TWITTER", "accountName": "johndoe", "status": "PUBLISHED", "platformPostId": "1234567890", "errorMessage": null, "publishedAt": "2026-06-15T10:00:12.000Z" },
    { "platformId": "pp_abc002", "platform": "TIKTOK", "accountName": "johndoe", "status": "FAILED", "platformPostId": null, "errorMessage": "Spam risk: too many posts in a short window", "publishedAt": null }
  ]
}
```

Take `platformId` from `FAILED` rows when calling `POST /social-posts/:id/retry`. Use `GET /social-posts/:id` instead when you also need the content and schedule.

### PATCH /social-posts/:id

Update a `DRAFT` or `SCHEDULED` post. Any other status is rejected with `400` `Cannot edit post in current state` rather than partially applied.

Accepts the same body as `POST /social-posts`, minus `saveAsDraft`. Updates are partial: `text`, `contentType`, `scheduledAt`, `timezone`, `thumbnailUrl`, and `thumbnailTimestampMs` you omit keep their values. `platforms` is the exception: sending it rebuilds the post's targets from that request alone, so resend every `*ConnectionIds` array and platform config you want to keep. `mediaUrls` only take effect together with `platforms`, and on a `SCHEDULED` post they are verified in storage the same way as on create. Omitting `platforms` leaves accounts, configs, and media untouched.

**Response:** the updated post, in the same shape as `GET /social-posts/:id`.

### DELETE /social-posts/:id

Delete a post record. Use it to cancel a `DRAFT` or `SCHEDULED` post; a deleted scheduled post will not publish. The API does not refuse other statuses, but deleting a `COMPLETED` or `PARTIAL_FAILURE` post only drops AdaptlyPost's record: the content already exists on each network, and removing it there is a manual step. Prefer `PATCH` over delete-and-recreate. Irreversible.

**Response:** `{ "deleted": true }`

### POST /social-posts/:id/publish

Publish a draft, either immediately or on a schedule. Accepts a `DRAFT`, and also a `SCHEDULED` post to reschedule it or push it live; any other status returns `400` `Post is not a draft`.

**Request:**

```json
{ "scheduledAt": "2026-03-15T10:00:00Z", "timezone": "UTC" }
```

Omit `scheduledAt` (or pass a past time) to publish now: the post moves to `PENDING`, a publishing job is queued per platform, and `queuedPlatforms` lists them. This is irreversible from the agent's side once it returns. A future `scheduledAt` sets `SCHEDULED` and returns an empty `queuedPlatforms`. `timezone` is required (use `UTC` if unknown); it is stored for display and does not shift `scheduledAt`. Fails with `400` if an account on the draft was disconnected (`Connection not found for <platform>`) or a TikTok entry has no `privacyLevel` (`Privacy level is required for TikTok posts`); fix those with `PATCH` first.

**Response:** `{ "postId", "queuedPlatforms", "isScheduled", "scheduledAt" }`. Read `GET /social-posts/:id/results` afterwards for the per-platform outcome.

### POST /social-posts/:id/retry

Retry the platforms that failed on a post. Only rows whose status is `FAILED` and whose id is in `platformIds` are reset to `PENDING` and re-queued with the same content; other ids are ignored, and if none qualify the API returns `400` `No failed platforms to retry`. The post moves to `PUBLISHING` and the retry is asynchronous, so read the results endpoint again afterwards.

**Request:**

```json
{ "platformIds": ["pp_abc002"] }
```

**Response:** `{ "postId", "queuedPlatforms", "isScheduled": false }`

Get `platformIds` (not platform names) from `GET /social-posts/:id/results`. Retry only after the cause is fixed. A platform restriction is that network's decision about the account and a retry will not clear it, while a refreshed token or replaced media will.

### POST /connect-links

Mint a one-time link that lets someone connect a social account to this account group without an AdaptlyPost login of their own. Built for agencies onboarding a client, and for agents that need an account connected but must never handle the credentials.

**Response:**

```json
{
  "url": "https://adaptlypost.com/connect/abc123",
  "token": "abc123",
  "expiresAt": "2026-03-16T10:00:00.000Z"
}
```

Send the `url` to the person who owns the account. Anyone holding it can attach an account to your group, so treat it as a secret and revoke it once used.

### DELETE /connect-links/:token

Revoke a connect link before it is used or after it expires.

**Response:** `{ "success": true }`

Returns `404` when the token does not exist or belongs to another account group.

## Webhooks

Rather than polling `GET /social-posts` to find out whether something published, register a URL and let AdaptlyPost call you.

### Events

| event | fires when |
|---|---|
| `post.scheduled` | A post is accepted onto the schedule |
| `post.published` | Every targeted platform published |
| `post.partially_failed` | Some platforms published and some failed |
| `post.failed` | Every platform failed |

### POST /api/v1/webhooks

**Request:** `{ "url": "https://example.com/hooks/adaptlypost" }`

**Response:**

```json
{
  "id": "wh_abc123",
  "url": "https://example.com/hooks/adaptlypost",
  "active": true,
  "secret": "whsec_..."
}
```

> The signing secret is returned **only here, only once**. It is not in `GET /webhooks` or `GET /webhooks/:id`. Store it when you create the webhook or delete it and make a new one.

Maximum 10 webhooks per account group.

### GET /api/v1/webhooks

Returns `{ "webhooks": [...] }` without secrets.

### GET /api/v1/webhooks/:id

One webhook, without its secret.

### PATCH /api/v1/webhooks/:id

Body accepts `url` and `active`. Set `active: false` to pause deliveries without losing the registration and its secret.

### DELETE /api/v1/webhooks/:id

**Response:** `{ "deleted": true }`

### POST /api/v1/webhooks/:id/test

Sends a `webhook.test` event to the registered URL so you can verify signature checking before a real post depends on it.

### Verifying a delivery

Each request carries four headers:

| header | contents |
|---|---|
| `x-adaptly-signature` | `sha256=<hex>` |
| `x-adaptly-timestamp` | Unix timestamp used in the signature |
| `x-adaptly-event` | Event name, for example `post.published` |
| `x-adaptly-webhook-id` | Which registration produced this delivery |

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`, hex encoded and prefixed with `sha256=`. Sign the **raw** body, before any JSON parsing, or the bytes will not match.

```js
const expected =
  "sha256=" +
  crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

Compare with a timing-safe function, and reject timestamps that are far from now so an old capture cannot be replayed.

### Delivery behaviour

AdaptlyPost retries a failing endpoint 5 times with a 10 second timeout per attempt. After 20 consecutive failures the webhook is deactivated, which is why a receiver that has been down for a while goes quiet and stays quiet: reactivate it with `PATCH /webhooks/:id`.

## Rate limits

600 requests per minute per API token, counted on a hash of the token rather than on IP.

Every response carries the RFC 9331 headers:

```
RateLimit-Policy: "adaptlypost-api";q=600;w=60
RateLimit-Limit: 600
RateLimit-Remaining: 587
RateLimit-Reset: 43
```

A `429` adds `Retry-After` in seconds. Wait it out rather than retrying immediately, since a retry inside the window just burns the next allowance.

## GET /openapi.json

The full OpenAPI 3 spec, and the one endpoint that needs no authentication, so Make, n8n and Zapier can import it without a token.

## Enums

**PlatformType:**
`FACEBOOK`, `INSTAGRAM`, `THREADS`, `TIKTOK`, `TWITTER`, `BLUESKY`, `LINKEDIN`, `PINTEREST`, `YOUTUBE`

**ContentType:**
`TEXT`, `IMAGE`, `VIDEO`, `CAROUSEL`

**TikTokPrivacyLevel:**
`PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`

**MetaVideoPostType (Instagram & Facebook):**
`FEED`, `REEL`, `STORY`

**YouTubePostType:**
`VIDEO`, `SHORTS`

**YouTubePrivacyStatus:**
`public`, `private`, `unlisted`

**YouTubeLicense:**
`youtube`, `creativeCommon`

## Error Responses

- `400` — Bad request (missing fields, invalid data, validation errors)
- `401` — Invalid, expired, or missing API token
- `404` — Resource not found or access denied
- `429` — Rate limit exceeded; see `Retry-After`

**Example error:**

```json
{
  "message": ["timezone must be a string", "timezone should not be empty"],
  "error": "Bad Request",
  "statusCode": 400
}
```
