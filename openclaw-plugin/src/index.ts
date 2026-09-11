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
        "Restrict to these platforms; omit for every platform with analytics. TWITTER has none and is ignored; LINKEDIN returns no data until LinkedIn approves analytics access.",
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
};

export default definePluginEntry({
  id: "adaptlypost",
  name: "AdaptlyPost",
  description:
    "Schedule and publish social posts to LinkedIn, X, Instagram, Facebook, TikTok, YouTube, Pinterest, Threads and Bluesky, and read how they performed.",
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
              if (decision === "allow-once") approvals.grant(toolCallId, params);
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
        "List the social accounts connected to the token's workspace across all nine platforms. Returns { accounts } with id, platform, displayName, username, avatarUrl, and pageId for Facebook pages. Call this before adaptlypost_create_post: it takes these ids, never usernames. Put each id in the array for its platform (linkedinConnectionIds, tiktokConnectionIds, and so on); Facebook page accounts go in pageIds. Not for post history or publishing status: use adaptlypost_list_posts or adaptlypost_post_results for those. Takes no arguments.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        return jsonResult(await callApi(cfg(), "GET", "/social-accounts", { signal }));
      },
    });

    api.registerTool({
      name: UPLOAD_TOOL,
      label: "AdaptlyPost: upload media",
      description:
        "Upload images or videos to AdaptlyPost storage and return public URLs for adaptlypost_create_post mediaUrls. Every call pauses for the user's approval, because stored files are public immediately, post or no post; only upload files the user named. Two sources, combinable in one call: file_paths (files inside the folders the user listed in the plugin's mediaDirs setting; hidden files are refused) and urls (public https URLs the plugin downloads and re-hosts; private and internal addresses are refused). Accepts JPEG, PNG, WebP, MP4 and QuickTime, checked by file content. Limits: 50 MB per image, 1 GB per local video, 250 MB per URL. A post referencing media that was never uploaded fails with 'Media file(s) not found in storage'. Returns uploaded ({ publicUrl, key } per file) and mediaUrls; pass mediaUrls straight into the post.",
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
        "Create one post for one or more platforms. mode is required and says what happens: DRAFT stores it for review in the AdaptlyPost app and needs no approval; SCHEDULE (with a future scheduledAt) and PUBLISH_NOW pause for the user's approval of the exact content, accounts and timing, and a denied or unanswered approval publishes nothing. Pick DRAFT whenever the user has not explicitly said to post now or at a set time, and always in unattended runs. Publishing runs asynchronously per platform, so the response ({ postId, queuedPlatforms, isScheduled, scheduledAt }) is not the outcome; read adaptlypost_post_results, where each platform succeeds or fails on its own. Call adaptlypost_accounts first: each platform in platforms needs its connection-id array (linkedinConnectionIds, pageIds for Facebook, and so on), one account per platform. TikTok needs tiktokConfigs with privacyLevel; Pinterest needs pinterestConfigs with boardId. mediaUrls must come from adaptlypost_upload_media, or the call fails with 'Media file(s) not found in storage'. Vary the caption per platform with platformTexts when posting widely: identical text across many accounts is what spam classifiers look for.",
      parameters: Type.Object({
        platforms: Type.Array(Platform, {
          minItems: 1,
          description:
            "Target platforms. Each needs its matching connection-id array (pageIds for FACEBOOK) filled with ids from adaptlypost_accounts.",
        }),
        contentType: Type.Union(
          [Type.Literal("TEXT"), Type.Literal("IMAGE"), Type.Literal("VIDEO"), Type.Literal("CAROUSEL")],
          { description: "Must match the media supplied. CAROUSEL needs more than one mediaUrl." },
        ),
        text: Type.Optional(Type.String({ description: "Default caption shared across platforms." })),
        platformTexts: Type.Optional(
          Type.Array(Type.Object({ platform: Platform, text: Type.String() }), {
            description: "Per-platform caption overrides.",
          }),
        ),
        mediaUrls: Type.Optional(
          Type.Array(Type.String(), {
            description: "publicUrl values returned by adaptlypost_upload_media.",
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
        const body = buildPostBody(params as Record<string, unknown>);
        if ((params as { mode: string }).mode !== "DRAFT") approvals.consume(toolCallId, CREATE_POST_TOOL, params);
        return jsonResult(await callApi(cfg(), "POST", "/social-posts", { body, signal }));
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
        "Re-queue publishing for a post's FAILED platforms. It republishes immediately, so every call pauses for the user's approval. Only rows with status FAILED whose id is in platform_ids are reset to PENDING and retried with the same content; other ids are ignored, and with none matching the call fails with 'No failed platforms to retry'. The post moves to PUBLISHING and the retry is asynchronous, so check adaptlypost_post_results for the outcome. Get platform_ids (not platform names) and each errorMessage from adaptlypost_post_results first; retry once the cause is fixed (reconnected account, replaced media), not for a platform restriction, which repeated retries make worse. Content cannot change on retry.",
      parameters: Type.Object({
        post_id: Type.String({ description: "Post id whose platforms failed." }),
        platform_ids: Type.Array(Type.String(), {
          minItems: 1,
          description: "platformId values of FAILED rows from adaptlypost_post_results, not platform names.",
        }),
      }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, RETRY_TOOL, params);
        const { post_id: postId, platform_ids: platformIds } = params as {
          post_id: string;
          platform_ids: string[];
        };
        return jsonResult(
          await callApi(cfg(), "POST", `/social-posts/${encodeURIComponent(postId)}/retry`, {
            body: { platformIds },
            signal,
          }),
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
