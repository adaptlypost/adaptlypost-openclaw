import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  callApi,
  readConfig,
  uploadLocalFile,
  uploadRemoteUrl,
  type PluginConfig,
} from "./api.js";
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalLedger,
  buildPostBody,
  CREATE_POST_TOOL,
  describeApproval,
  GATED_TOOLS,
  RETRY_TOOL,
  UNSCHEDULE_TOOL,
  UPLOAD_TOOL,
} from "./approvals.js";

const Platform = Type.Union(
  [
    Type.Literal("LINKEDIN"),
    Type.Literal("YOUTUBE"),
    Type.Literal("INSTAGRAM"),
    Type.Literal("FACEBOOK"),
    Type.Literal("TIKTOK"),
    Type.Literal("PINTEREST"),
    Type.Literal("THREADS"),
    Type.Literal("BLUESKY"),
    Type.Literal("TWITTER"),
    Type.Literal("MASTODON"),
    Type.Literal("GOOGLE_BUSINESS"),
  ],
  { description: "AdaptlyPost platform identifier." },
);

const PostStatus = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("SCHEDULED"),
  Type.Literal("PENDING"),
  Type.Literal("PUBLISHING"),
  Type.Literal("COMPLETED"),
  Type.Literal("PARTIAL_FAILURE"),
  Type.Literal("FAILED"),
]);

const AnalyticsSortMetric = Type.Union([
  Type.Literal("VIEWS"),
  Type.Literal("LIKES"),
  Type.Literal("COMMENTS"),
  Type.Literal("SHARES"),
  Type.Literal("SAVES"),
  Type.Literal("CLICKS"),
  Type.Literal("IMPRESSIONS"),
  Type.Literal("ENGAGEMENT_RATE"),
  Type.Literal("PUBLISHED_AT"),
]);

const AnalyticsRangeFields = {
  from: Type.String({
    description:
      "Start of the reporting window, ISO 8601 (e.g. 2026-08-01). Metrics cover posts published between from and to; the comparison window is the same length just before from.",
  }),
  to: Type.String({ description: "End of the reporting window, ISO 8601. Not earlier than from." }),
  platforms: Type.Optional(
    Type.Array(Platform, {
      description:
        "Restrict to these platforms; omit for every platform with analytics. TWITTER and MASTODON have none and are ignored; GOOGLE_BUSINESS has location-level impressions only, with no per-post metrics; LINKEDIN returns no data until LinkedIn approves analytics access.",
    }),
  ),
};

const ConnectionIdFields = {
  linkedinConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "LinkedIn connection ids." })),
  twitterConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "X (Twitter) connection ids." })),
  instagramConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Instagram connection ids." })),
  youtubeConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "YouTube channel connection ids." })),
  tiktokConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "TikTok connection ids." })),
  threadsConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Threads connection ids." })),
  blueskyConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Bluesky connection ids." })),
  mastodonConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Mastodon connection ids." })),
  googleBusinessConnectionIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Google Business Profile connection ids; each id is one business location. Text or one JPEG/PNG image (max 5 MB), no video or carousels, text max 1500 characters. Google removes posts with a phone number or email in the text (use the CALL button) and reviews every post, so one can come back rejected.",
    }),
  ),
  pinterestConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Pinterest connection ids." })),
  pageIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Facebook page account ids from adaptlypost_accounts (the account id; its pageId value also works). Facebook has no connection-id array.",
    }),
  ),
};

const PlatformConfigFields = {
  tiktokConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        privacyLevel: Type.Union([
          Type.Literal("PUBLIC_TO_EVERYONE"),
          Type.Literal("MUTUAL_FOLLOW_FRIENDS"),
          Type.Literal("FOLLOWER_OF_CREATOR"),
          Type.Literal("SELF_ONLY"),
        ]),
        title: Type.Optional(Type.String({ maxLength: 90 })),
        sendAsDraft: Type.Optional(Type.Boolean()),
        aiGenerated: Type.Optional(Type.Boolean()),
      }),
      { description: "Required for TikTok: each entry needs connectionId and privacyLevel, which has no default." },
    ),
  ),
  youtubeConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        postType: Type.Optional(Type.Union([Type.Literal("VIDEO"), Type.Literal("SHORTS")])),
        videoTitle: Type.Optional(Type.String({ maxLength: 100 })),
        privacyStatus: Type.Optional(
          Type.Union([Type.Literal("public"), Type.Literal("private"), Type.Literal("unlisted")]),
        ),
        madeForKids: Type.Optional(Type.Boolean()),
      }),
      { description: "YouTube uploads without a videoTitle publish under the caption text." },
    ),
  ),
  instagramConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        postType: Type.Optional(
          Type.Union([Type.Literal("FEED"), Type.Literal("REEL"), Type.Literal("STORY")]),
        ),
      }),
    ),
  ),
  facebookConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        pageId: Type.String(),
        postType: Type.Optional(
          Type.Union([Type.Literal("FEED"), Type.Literal("REEL"), Type.Literal("STORY")]),
        ),
        videoTitle: Type.Optional(Type.String({ maxLength: 255 })),
      }),
      { description: "Facebook per-page config. pageId must match an entry in pageIds." },
    ),
  ),
  linkedinConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        documentTitle: Type.Optional(
          Type.String({
            maxLength: 100,
            description: "Title LinkedIn shows on a DOCUMENT post. Defaults to the file name.",
          }),
        ),
      }),
      { description: "LinkedIn per-connection config, only used by DOCUMENT posts. connectionId must match linkedinConnectionIds." },
    ),
  ),
  pinterestConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        boardId: Type.String({
          description:
            "Required. Pinterest rejects a pin with no board, and there is no API to list boards, so ask the user for the board id.",
        }),
        title: Type.Optional(Type.String({ maxLength: 100 })),
        link: Type.Optional(Type.String()),
      }),
    ),
  ),
  googleBusinessConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        topicType: Type.Union([Type.Literal("STANDARD"), Type.Literal("EVENT"), Type.Literal("OFFER")], {
          description: "STANDARD is an update. EVENT and OFFER need eventTitle, eventStart and eventEnd.",
        }),
        callToActionType: Type.Optional(
          Type.Union(
            [
              Type.Literal("BOOK"),
              Type.Literal("ORDER"),
              Type.Literal("SHOP"),
              Type.Literal("LEARN_MORE"),
              Type.Literal("SIGN_UP"),
              Type.Literal("CALL"),
            ],
            {
              description:
                "Button on the post. Every type except CALL needs callToActionUrl; CALL dials the phone number on the business profile and ignores callToActionUrl.",
            },
          ),
        ),
        callToActionUrl: Type.Optional(Type.String({ format: "uri" })),
        eventTitle: Type.Optional(Type.String({ description: "Required for EVENT and OFFER." })),
        eventStart: Type.Optional(
          Type.String({
            pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
            description:
              "Required for EVENT and OFFER. The business's local time as YYYY-MM-DD or YYYY-MM-DDTHH:mm, no timezone.",
          }),
        ),
        eventEnd: Type.Optional(
          Type.String({
            pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
            description:
              "Required for EVENT and OFFER. The business's local time as YYYY-MM-DD or YYYY-MM-DDTHH:mm, no timezone.",
          }),
        ),
        offerCouponCode: Type.Optional(Type.String({ description: "OFFER only." })),
        offerRedeemUrl: Type.Optional(Type.String({ format: "uri", description: "OFFER only." })),
        offerTerms: Type.Optional(Type.String({ description: "OFFER only." })),
      }),
      {
        description:
          "Google Business Profile per-location config, one per connection. A location without one gets a STANDARD update with no button.",
      },
    ),
  ),
};

export default definePluginEntry({
  id: "adaptlypost",
  name: "AdaptlyPost",
  description:
    "Schedule and publish social posts to LinkedIn, X, Instagram, Facebook, TikTok, YouTube, Pinterest, Threads, Bluesky, Mastodon and Google Business Profile, and read how they performed.",
  register(api) {
    const cfg = (): PluginConfig => readConfig(api as { config?: unknown });
    const approvals = new ApprovalLedger();

    api.on(
      "before_tool_call",
      async (event) => {
        let approval;
        try {
          approval = await describeApproval(cfg(), event.toolName, event.params);
        } catch (error) {
          return { block: true, blockReason: error instanceof Error ? error.message : String(error) };
        }
        if (!approval) return;

        const { toolCallId, toolName, params } = event;
        if (!toolCallId) {
          return {
            block: true,
            blockReason: `${toolName} needs a human approval, and this run gives no tool call id to bind it to. Nothing was uploaded or published.`,
          };
        }
        return {
          requireApproval: {
            ...approval,
            allowedDecisions: ["allow-once", "deny"],
            timeoutMs: APPROVAL_TIMEOUT_MS,
            onResolution(decision) {
              if (decision === "allow-once") approvals.grant(toolCallId, params, approval.fallback);
            },
          },
        };
      },
      { matcher: GATED_TOOLS },
    );

    api.registerTool({
      name: "adaptlypost_accounts",
      label: "AdaptlyPost: list accounts",
      description:
        "List the social accounts connected to the token's workspace across all eleven platforms. Returns { accounts } with id, platform, displayName, username, avatarUrl, status, and pageId for Facebook pages. Call this before adaptlypost_create_post: it takes these ids, never usernames. Put each id in the array for its platform (linkedinConnectionIds, tiktokConnectionIds, and so on); Facebook page accounts go in pageIds. status is active or unauthorized; an unauthorized account stays listed but its platform rejected the stored token (unauthorizedReason says why) and adaptlypost_create_post refuses it with 400, so skip it and tell the user to reconnect it in the dashboard, then adaptlypost_check_account to confirm. Not for post history or publishing status: use adaptlypost_list_posts or adaptlypost_post_results for those. Takes no arguments.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        return jsonResult(await callApi(cfg(), "GET", "/social-accounts", { signal }));
      },
    });

    api.registerTool({
      name: "adaptlypost_check_account",
      label: "AdaptlyPost: re-check an account",
      description:
        "Ask the platform right now whether a connected account's stored token still works, and return its fresh status. Facebook pages only (other platforms return 400). Use it after the user says they reconnected a page that adaptlypost_accounts listed as unauthorized, or when a post failed with a token error and you want to confirm the page is back before scheduling to it again. Returns { id, platform, displayName, pageId, status, unauthorizedReason, checkedAt }; a rejected token marks the page unauthorized, a working token clears an earlier mark. Pages are also re-checked automatically twice a day, so do not poll this.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "The account id from adaptlypost_accounts (or the Facebook pageId).",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const { account_id: accountId } = params as { account_id: string };
        return jsonResult(
          await callApi(cfg(), "POST", `/social-accounts/${encodeURIComponent(accountId)}/check`, {
            signal,
          }),
        );
      },
    });

    api.registerTool({
      name: UPLOAD_TOOL,
      label: "AdaptlyPost: upload media",
      description:
        "Upload images, videos or documents to AdaptlyPost storage and return public URLs for adaptlypost_create_post mediaUrls. Every call pauses for the user's approval, because stored files are public immediately, post or no post; only upload files the user named. Two sources, combinable in one call: file_paths (files inside the folders the user listed in the plugin's mediaDirs setting; hidden files are refused) and urls (public https URLs the plugin downloads and re-hosts; private and internal addresses are refused). Accepts JPEG, PNG, WebP, MP4 and QuickTime, plus PDF, PPT, PPTX, DOC and DOCX for LinkedIn DOCUMENT posts, checked by file content (and, for Office files, the extension). Limits: 50 MB per image, 1 GB per local video, 100 MB per document, 250 MB per URL. A post referencing media that was never uploaded fails with 'Media file(s) not found in storage'. Returns uploaded ({ publicUrl, key } per file) and mediaUrls; pass mediaUrls straight into the post. One publicUrl may be reused across any number of posts; the file is kept until the last post referencing it has published, so upload once and reuse.",
      parameters: Type.Object({
        file_paths: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Absolute paths inside a configured mediaDirs folder, or paths relative to the first mediaDirs folder.",
          }),
        ),
        urls: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Public https URLs to download and re-host. AdaptlyPost will not post media it does not store.",
          }),
        ),
      }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, UPLOAD_TOOL, params);
        const { file_paths: filePaths = [], urls = [] } = params as {
          file_paths?: string[];
          urls?: string[];
        };
        if (!filePaths.length && !urls.length) {
          throw new Error("Provide at least one of file_paths or urls.");
        }

        const config = cfg();
        const uploaded = [
          ...(await Promise.all(filePaths.map((p) => uploadLocalFile(config, p, signal)))),
          ...(await Promise.all(urls.map((u) => uploadRemoteUrl(config, u, signal)))),
        ];

        return jsonResult({
          uploaded,
          mediaUrls: uploaded.map((item) => item.publicUrl),
        });
      },
    });

    api.registerTool({
      name: CREATE_POST_TOOL,
      label: "AdaptlyPost: create or schedule a post",
      description:
        "Create one post for one or more platforms. mode is required and says what happens: DRAFT stores it for review in the AdaptlyPost app and needs no approval; SCHEDULE (with a future scheduledAt) and PUBLISH_NOW pause for the user's approval of the exact content, accounts and timing, and a denied or unanswered approval publishes nothing. Pick DRAFT whenever the user has not explicitly said to post now or at a set time, and always in unattended runs. The API key carries a workspace role: a Contributor key can only draft, so SCHEDULE and PUBLISH_NOW get 403 permission_denied from AdaptlyPost; when the plugin knows the key cannot do what was asked, the approval prompt says so and offers to save a draft instead, and the result then carries savedAsDraft: true. Publishing runs asynchronously per platform, so the response ({ postId, queuedPlatforms, isScheduled, scheduledAt }) is not the outcome; read adaptlypost_post_results, where each platform succeeds or fails on its own. Call adaptlypost_accounts first: each platform in platforms needs its connection-id array (linkedinConnectionIds, pageIds for Facebook, and so on), one account per platform. TikTok needs tiktokConfigs with privacyLevel; Pinterest needs pinterestConfigs with boardId; Google Business Profile takes googleBusinessConfigs with topicType. For a LinkedIn document (PDF, slides or Word file) use contentType DOCUMENT with that one file in mediaUrls and only LINKEDIN in platforms. mediaUrls must come from adaptlypost_upload_media, or the call fails with 'Media file(s) not found in storage'. Vary the caption per platform with platformTexts when posting widely: identical text across many accounts is what spam classifiers look for.",
      parameters: Type.Object({
        platforms: Type.Array(Platform, {
          minItems: 1,
          description:
            "Target platforms. Each needs its matching connection-id array (pageIds for FACEBOOK) filled with ids from adaptlypost_accounts.",
        }),
        contentType: Type.Union(
          [
            Type.Literal("TEXT"),
            Type.Literal("IMAGE"),
            Type.Literal("VIDEO"),
            Type.Literal("CAROUSEL"),
            Type.Literal("DOCUMENT"),
          ],
          {
            description:
              "Must match the media supplied. CAROUSEL needs more than one mediaUrl. DOCUMENT is LinkedIn only: exactly one PDF, PPT, PPTX, DOC or DOCX file (max 100 MB, 300 pages), titled with linkedinConfigs.",
          },
        ),
        text: Type.Optional(Type.String({ description: "Default caption shared across platforms." })),
        platformTexts: Type.Optional(
          Type.Array(Type.Object({ platform: Platform, text: Type.String() }), {
            description: "Per-platform caption overrides.",
          }),
        ),
        mediaUrls: Type.Optional(
          Type.Array(Type.String(), {
            description: "publicUrl values returned by adaptlypost_upload_media. The same publicUrl may be reused across posts; do not reuse mediaUrls read back from a published post.",
          }),
        ),
        mediaAltTexts: Type.Optional(
          Type.Array(Type.String({ maxLength: 1000 }), {
            description:
              'Alt text per image, in the same order as mediaUrls; use "" to skip an image. Sent to X, Bluesky, Mastodon, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500 characters). TikTok, YouTube, Google Business Profile and videos ignore it.',
          }),
        ),
        mode: Type.Union([Type.Literal("DRAFT"), Type.Literal("SCHEDULE"), Type.Literal("PUBLISH_NOW")], {
          description:
            "DRAFT: save without publishing. SCHEDULE: publish at scheduledAt. PUBLISH_NOW: publish immediately. SCHEDULE and PUBLISH_NOW require user approval.",
        }),
        scheduledAt: Type.Optional(
          Type.String({
            description:
              "Absolute ISO 8601 instant in the future. Required with mode SCHEDULE, rejected with the other modes.",
          }),
        ),
        timezone: Type.Optional(
          Type.String({
            description:
              "IANA timezone stored with the post for display, defaults to UTC; it does not shift scheduledAt.",
          }),
        ),
        thumbnailUrl: Type.Optional(Type.String({ description: "Custom thumbnail for video posts." })),
        ...ConnectionIdFields,
        ...PlatformConfigFields,
      }),
      async execute(toolCallId, params, signal) {
        const post = params as Record<string, unknown> & { mode: string };
        let body = buildPostBody(post);
        let savedAsDraft = false;
        if (post.mode !== "DRAFT") {
          const { fallback } = approvals.consume(toolCallId, CREATE_POST_TOOL, params);
          if (fallback === "draft") {
            const { scheduledAt: _scheduledAt, ...rest } = post;
            body = buildPostBody({ ...rest, mode: "DRAFT" });
            savedAsDraft = true;
          }
        }
        const result = await callApi(cfg(), "POST", "/social-posts", { body, signal });
        if (!savedAsDraft) return jsonResult(result);
        return jsonResult({
          ...(result as Record<string, unknown>),
          savedAsDraft: true,
          note: `Saved as a draft instead of ${post.mode === "PUBLISH_NOW" ? "publishing" : "scheduling"}: this key's role cannot do that, and the user approved the draft. A workspace member can publish it in the AdaptlyPost app.`,
        });
      },
    });

    api.registerTool({
      name: "adaptlypost_list_posts",
      label: "AdaptlyPost: list posts",
      description:
        "List posts in the token's workspace, any status, newest first by default. Returns { posts, total, hasMore }; each post carries its status and a platforms array with per-platform status. Filters: statuses, platforms (posts targeting any of them), and startDate/endDate, which bound scheduledAt, or createdAt for posts never scheduled. limit is 1 to 100 (default 20); page with offset while hasMore is true. Check what is already queued before adding more: stacking several posts onto one account in a short window is the most common cause of a platform restriction. Use adaptlypost_post_results for one post's per-platform outcomes and retry ids.",
      parameters: Type.Object({
        statuses: Type.Optional(
          Type.Array(PostStatus, { description: "Filter by post status; omit for all statuses." }),
        ),
        platforms: Type.Optional(
          Type.Array(Platform, { description: "Filter to posts targeting any of these platforms." }),
        ),
        startDate: Type.Optional(
          Type.String({
            description:
              "Lower bound (ISO 8601) on scheduledAt, or createdAt for posts never scheduled.",
          }),
        ),
        endDate: Type.Optional(
          Type.String({
            description:
              "Upper bound (ISO 8601) on scheduledAt, or createdAt for posts never scheduled.",
          }),
        ),
        sortOrder: Type.Optional(
          Type.Union([Type.Literal("NEWEST"), Type.Literal("OLDEST")], {
            description: "NEWEST (default) or OLDEST.",
          }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "1 to 100, defaults to 20." })),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Posts to skip; increase by limit while hasMore is true.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(
          await callApi(cfg(), "GET", "/social-posts", {
            query: params as Record<string, unknown>,
            signal,
          }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_post_results",
      label: "AdaptlyPost: per-platform results",
      description:
        "Get one post's per-platform publishing outcomes: { postId, status, results[] } where each result has platformId, platform, accountName, status (PENDING, PUBLISHING, PUBLISHED, or FAILED), platformPostId, errorMessage, and publishedAt. Each platform reports separately, so read every row rather than treating a post as one pass or fail. Call this after adaptlypost_create_post or adaptlypost_retry_failed, since publishing is asynchronous and their responses only confirm queueing; poll until no row is PENDING or PUBLISHING. Take platformId from FAILED rows for adaptlypost_retry_failed. A platform restriction is that platform's decision about the account and retrying will not clear it; a dead token or rejected media will.",
      parameters: Type.Object({
        post_id: Type.String({
          description: "Post id from adaptlypost_create_post or adaptlypost_list_posts.",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const { post_id: postId } = params as { post_id: string };
        return jsonResult(
          await callApi(cfg(), "GET", `/social-posts/${encodeURIComponent(postId)}/results`, { signal }),
        );
      },
    });

    api.registerTool({
      name: RETRY_TOOL,
      label: "AdaptlyPost: retry failed platforms",
      description:
        "Re-queue publishing for a post's FAILED platforms. It republishes immediately, so every call pauses for the user's approval. platform_ids takes platformId values from adaptlypost_post_results, platform names such as 'BLUESKY' (every failed row of that platform), or can be left empty to retry every failed row. Only rows with status FAILED are reset to PENDING and retried with the same content. A value matching neither a row id nor a platform of the post fails with 'Unknown retry target'; with nothing failed among the matches the call fails with 'No failed platforms to retry'. The post moves to PUBLISHING and the retry is asynchronous, so check adaptlypost_post_results for the outcome. Read each errorMessage first and retry once the cause is fixed (reconnected account, replaced media), not for a platform restriction, which repeated retries make worse. Content cannot change on retry.",
      parameters: Type.Object({
        post_id: Type.String({ description: "Post id whose platforms failed." }),
        platform_ids: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "platformId values from adaptlypost_post_results or platform names such as BLUESKY. Omit to retry every FAILED row.",
          }),
        ),
      }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, RETRY_TOOL, params);
        const { post_id: postId, platform_ids: platformIds } = params as {
          post_id: string;
          platform_ids?: string[];
        };
        return jsonResult(
          await callApi(cfg(), "POST", `/social-posts/${encodeURIComponent(postId)}/retry`, {
            body: platformIds?.length ? { platformIds } : {},
            signal,
          }),
        );
      },
    });

    api.registerTool({
      name: UNSCHEDULE_TOOL,
      label: "AdaptlyPost: unschedule a post",
      description:
        "Take a SCHEDULED post, or a DRAFT that still has a date, off the calendar. It becomes an undated DRAFT with scheduledAt null, keeps its content, media and accounts, and nothing publishes until someone schedules it again in the AdaptlyPost app. Every call pauses for the user's approval. Use it when the user wants a post pulled without deleting it; this plugin cannot reschedule, so tell the user to pick the new time in the app. Fails with 400 'Cannot edit post in current state' for any other status, and 404 for an id outside the token's workspace. Returns the post as an undated draft in the shape of adaptlypost_list_posts entries.",
      parameters: Type.Object({
        post_id: Type.String({
          description: "Id of the scheduled post, from adaptlypost_list_posts or adaptlypost_create_post.",
        }),
      }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, UNSCHEDULE_TOOL, params);
        const { post_id: postId } = params as { post_id: string };
        return jsonResult(
          await callApi(cfg(), "POST", `/social-posts/${encodeURIComponent(postId)}/unschedule`, { signal }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_analytics_overview",
      label: "AdaptlyPost: analytics overview",
      description:
        "Workspace-wide performance for a date window: views, likes, comments, shares, followers, posts published, average views per post and engagement rate, each as { value, previousValue, deltaPercent } against the window of the same length just before it. Use it for 'how did we do this month' and follower questions. partialMetrics names metrics some selected platform cannot report; a metric no platform reports is null, so say so rather than reporting zero. Analytics cover the last 180 days and refresh every few hours (lastSyncedAt says when). Not for delivery status: adaptlypost_post_results answers 'did it publish', this answers 'how did it do'.",
      parameters: Type.Object(AnalyticsRangeFields),
      async execute(_toolCallId, params, signal) {
        return jsonResult(
          await callApi(cfg(), "GET", "/analytics/overview", {
            query: params as Record<string, unknown>,
            signal,
          }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_post_analytics",
      label: "AdaptlyPost: per-post analytics",
      description:
        "Per-post metrics for posts published inside a date window, sorted by a metric or by publish date, paginated. Use it for 'top posts', 'which post got the most comments' and 'how did post X do'. Returns { posts, total, page, limit, hasMore }; each post has platform, publishedAt, title, permalink, accountName and metrics { views, likes, comments, shares, saves, clicks, impressions, reach, engagementRate }, with null for metrics the platform does not report. Posts published outside AdaptlyPost are included with postId null. Sort by VIEWS with a small limit for a top list; PUBLISHED_AT (default) for a chronological review.",
      parameters: Type.Object({
        ...AnalyticsRangeFields,
        sortBy: Type.Optional(AnalyticsSortMetric),
        page: Type.Optional(Type.Integer({ minimum: 1, description: "Page number, from 1." })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100, description: "Posts per page, defaults to 20." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(
          await callApi(cfg(), "GET", "/analytics/posts", {
            query: params as Record<string, unknown>,
            signal,
          }),
        );
      },
    });
  },
});
