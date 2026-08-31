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

const ConnectionIdFields = {
  linkedinConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "LinkedIn connection ids." })),
  twitterConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "X (Twitter) connection ids." })),
  instagramConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Instagram connection ids." })),
  youtubeConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "YouTube channel connection ids." })),
  tiktokConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "TikTok connection ids." })),
  threadsConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Threads connection ids." })),
  blueskyConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Bluesky connection ids." })),
  pinterestConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Pinterest connection ids." })),
  pageIds: Type.Optional(Type.Array(Type.String(), { description: "Facebook page ids, not connection ids." })),
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
      { description: "Required for TikTok: privacyLevel has no default." },
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
    ),
  ),
  pinterestConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String(),
        boardId: Type.String({ description: "Required. Pinterest rejects a pin with no board." }),
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
    "Schedule and publish social posts to LinkedIn, X, Instagram, Facebook, TikTok, YouTube, Pinterest, Threads and Bluesky.",
  register(api) {
    const cfg = (): PluginConfig => readConfig(api as { config?: unknown });

    api.registerTool({
      name: "adaptlypost_accounts",
      label: "AdaptlyPost: list accounts",
      description:
        "List the social accounts connected to AdaptlyPost with their connection ids and platforms. Call this before creating a post: adaptlypost_create_post takes connection ids, never usernames. Facebook pages carry a pageId instead of a username and go in pageIds, not a connection id array.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        return jsonResult(await callApi(cfg(), "GET", "/social-accounts", { signal }));
      },
    });

    api.registerTool({
      name: "adaptlypost_upload_media",
      label: "AdaptlyPost: upload media",
      description:
        "Upload images or videos to AdaptlyPost storage and get back public URLs for adaptlypost_create_post mediaUrls. Takes local file paths, remote URLs, or both. Accepts jpeg, png, webp, mp4 and quicktime. A post referencing media that was never uploaded fails with 'Media file(s) not found in storage'.",
      parameters: Type.Object({
        file_paths: Type.Optional(
          Type.Array(Type.String(), { description: "Absolute or relative paths to files on disk." }),
        ),
        urls: Type.Optional(
          Type.Array(Type.String(), {
            description: "Public URLs to fetch and re-host. AdaptlyPost will not post media it does not store.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
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
      name: "adaptlypost_create_post",
      label: "AdaptlyPost: create or schedule a post",
      description:
        "Create one post targeting any set of connected accounts. Omit scheduledAt to publish immediately, or set saveAsDraft to store it without publishing. Media must already be uploaded through adaptlypost_upload_media. Each platform publishes independently, so one failure does not stop the others. Vary the caption per platform with platformTexts when posting the same content widely: identical text across many accounts is what spam classifiers look for.",
      parameters: Type.Object({
        platforms: Type.Array(Platform, {
          minItems: 1,
          description: "Target platforms. Must match the connection id arrays you fill in.",
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
        scheduledAt: Type.Optional(
          Type.String({ description: "ISO 8601 timestamp. Omit to publish immediately." }),
        ),
        timezone: Type.Optional(Type.String({ description: "IANA timezone, defaults to UTC." })),
        saveAsDraft: Type.Optional(Type.Boolean({ description: "Store without publishing or scheduling." })),
        thumbnailUrl: Type.Optional(Type.String({ description: "Custom thumbnail for video posts." })),
        ...ConnectionIdFields,
        ...PlatformConfigFields,
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(await callApi(cfg(), "POST", "/social-posts", { body: params, signal }));
      },
    });

    api.registerTool({
      name: "adaptlypost_list_posts",
      label: "AdaptlyPost: list posts",
      description:
        "List posts including scheduled and draft ones. Check what is already queued before adding more: stacking several posts onto one account in a short window is the most common cause of a platform restriction.",
      parameters: Type.Object({
        statuses: Type.Optional(Type.Array(PostStatus, { description: "Filter by post status." })),
        platforms: Type.Optional(Type.Array(Platform, { description: "Filter by platform." })),
        startDate: Type.Optional(Type.String({ description: "ISO 8601 lower bound." })),
        endDate: Type.Optional(Type.String({ description: "ISO 8601 upper bound." })),
        sortOrder: Type.Optional(Type.Union([Type.Literal("NEWEST"), Type.Literal("OLDEST")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "Defaults to 20." })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
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
        "Read the per-platform publishing result for one post. Each platform reports separately, so read this per platform rather than treating a post as one pass or fail. A platform restriction is that platform's decision about the account and retrying will not clear it; a dead token or rejected media will.",
      parameters: Type.Object({
        post_id: Type.String({ description: "Post id from adaptlypost_create_post or adaptlypost_list_posts." }),
      }),
      async execute(_toolCallId, params, signal) {
        const { post_id: postId } = params as { post_id: string };
        return jsonResult(
          await callApi(cfg(), "GET", `/social-posts/${encodeURIComponent(postId)}/results`, { signal }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_retry_failed",
      label: "AdaptlyPost: retry failed platforms",
      description:
        "Retry publishing on platforms that failed for one post. Take the platform ids from adaptlypost_post_results. Retry only after the underlying cause is fixed: repeatedly retrying a platform restriction makes it worse.",
      parameters: Type.Object({
        post_id: Type.String({ description: "Post id to retry." }),
        platform_ids: Type.Array(Type.String(), {
          minItems: 1,
          description: "Failed platform ids from adaptlypost_post_results.",
        }),
      }),
      async execute(_toolCallId, params, signal) {
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
  },
});
