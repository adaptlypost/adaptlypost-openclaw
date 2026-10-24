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
  DELETE_RECURRING_TOOL,
  describeApproval,
  GATED_TOOLS,
  PAUSE_RECURRING_TOOL,
  REMOVE_ACCOUNT_TOOL,
  RESUME_RECURRING_TOOL,
  RETRY_TOOL,
  UNSCHEDULE_TOOL,
  UPLOAD_TOOL,
} from "./approvals.js";

const POSTABLE_PLATFORMS = [
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
  Type.Literal("TELEGRAM"),
];

const Platform = Type.Union(POSTABLE_PLATFORMS, {
  description:
    "AdaptlyPost platform identifier. GOOGLE_BUSINESS is Google Business Profile; TELEGRAM is a Telegram channel or group.",
});

const PostStatus = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("SCHEDULED"),
  Type.Literal("PENDING"),
  Type.Literal("PUBLISHING"),
  Type.Literal("COMPLETED"),
  Type.Literal("PARTIAL_FAILURE"),
  Type.Literal("FAILED"),
]);

const RecurringPostStatus = Type.Union([Type.Literal("ACTIVE"), Type.Literal("PAUSED"), Type.Literal("ENDED")]);

const Weekday = Type.Union([
  Type.Literal("MONDAY"),
  Type.Literal("TUESDAY"),
  Type.Literal("WEDNESDAY"),
  Type.Literal("THURSDAY"),
  Type.Literal("FRIDAY"),
  Type.Literal("SATURDAY"),
  Type.Literal("SUNDAY"),
]);

const Recurrence = Type.Object(
  {
    frequency: Type.Union(
      [Type.Literal("DAILY"), Type.Literal("WEEKLY"), Type.Literal("MONTHLY"), Type.Literal("YEARLY")],
      {
        description:
          "How often the post repeats. YEARLY posts on the same date every year; a series started on February 29 posts on February 28 in other years.",
      },
    ),
    interval: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 30, description: "Repeat every N days, weeks, months or years. Defaults to 1." }),
    ),
    weekdays: Type.Optional(
      Type.Array(Weekday, {
        description: "WEEKLY only: the weekdays it goes out on. The weekday of scheduledAt is always included.",
      }),
    ),
    endsOn: Type.Optional(
      Type.String({
        description:
          "Last day a post may go out on, YYYY-MM-DD, inclusive. On or after the day of the first post. Not with maxOccurrences.",
      }),
    ),
    maxOccurrences: Type.Optional(
      Type.Integer({
        minimum: 2,
        maximum: 365,
        description: "Total number of posts the series publishes. Not with endsOn; omit both to repeat until paused or deleted.",
      }),
    ),
  },
  {
    description:
      "Repeat the post. Needs mode SCHEDULE: scheduledAt is the first post and sets the time of day in timezone. Not for drafts or TikTok. X and LinkedIn reject repeated identical text, so put spintax such as {Hi|Hello} in the text.",
  },
);

const RecurringPostId = Type.String({
  description: "Recurring post id, from adaptlypost_list_recurring_posts or the recurringPostId of adaptlypost_create_post.",
});

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
        "Restrict to these platforms; omit for every platform with analytics. MASTODON and TELEGRAM have none and are ignored.",
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
  pinterestConnectionIds: Type.Optional(Type.Array(Type.String(), { description: "Pinterest connection ids." })),
  googleBusinessConnectionIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Google Business Profile location ids from adaptlypost_accounts (platform GOOGLE_BUSINESS, displayName is the location title). A location without a googleBusinessConfigs entry posts a STANDARD update.",
    }),
  ),
  telegramConnectionIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Telegram channel and group ids from adaptlypost_accounts (platform TELEGRAM, displayName is the chat title). Text up to 4096 characters, up to 10 images (JPEG, PNG or WebP, 10 MB each) or one MP4 or MOV video up to 50 MB. A caption over 1024 characters goes out as its own message after the media.",
    }),
  ),
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
        aiGenerated: Type.Optional(
          Type.Boolean({
            description:
              'Disclose altered or synthetic content, such as an AI voice, an AI avatar or realistic footage that was generated or edited. YouTube shows its "Altered or synthetic content" label on the video. Works on videos and Shorts. Omit it or send false for no label.',
          }),
        ),
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
        trialGraduation: Type.Optional(
          Type.Union([Type.Literal("MANUAL"), Type.Literal("SS_PERFORMANCE")]),
        ),
        shareToStory: Type.Optional(
          Type.Boolean({
            description:
              "Also publish the same media as a story next to the FEED or REEL post. The story is its own entry in the post's platforms and succeeds, fails and retries on its own. It skips the caption, first comment, cover, collaborators, user tags, trial and audio, needs IMAGE, VIDEO or CAROUSEL, and a video must be 60 seconds or shorter. Ignored when postType is STORY.",
          }),
        ),
        collaborators: Type.Optional(
          Type.Array(Type.String({ pattern: "^@?[A-Za-z0-9._]{1,30}$" }), {
            maxItems: 3,
            description:
              "Up to 3 Instagram usernames invited as collaborators. Feed images, carousels and reels only; a story or trial reel with collaborators is a 400. Each collaborator must accept the invite in Instagram before the post shows on their profile.",
          }),
        ),
        userTags: Type.Optional(
          Type.Array(
            Type.Object({
              username: Type.String({
                pattern: "^@?[A-Za-z0-9._]{1,30}$",
                description: "Public Instagram username. A leading @ is stripped.",
              }),
              x: Type.Optional(
                Type.Number({ minimum: 0, maximum: 1, description: "0 to 1 from the left edge of the image." }),
              ),
              y: Type.Optional(
                Type.Number({ minimum: 0, maximum: 1, description: "0 to 1 from the top edge of the image." }),
              ),
            }),
            {
              maxItems: 20,
              description:
                "Up to 20 public Instagram accounts tagged in the media. One image (feed or story) or one video (Reel or story) only; a carousel or several stories with tags is a 400. A feed image needs both x and y on every tag; a story takes them optionally but never just one; a video ignores them and tags the person on the whole video. A repeated username keeps its first entry. If Instagram refuses a tag because the account is private or does not exist, the post goes out without its tags and the refused usernames come back in instagramUntaggedUsernames.",
            },
          ),
        ),
        aiGenerated: Type.Optional(
          Type.Boolean({
            description:
              'Disclose that the post was made or edited with AI. Instagram shows its "AI info" label on the post. Works on images, carousels, reels and stories, and a story made with shareToStory carries the label too.',
          }),
        ),
        audio: Type.Optional(
          Type.Object(
            {
              audioId: Type.String({
                maxLength: 64,
                description: "audioId from adaptlypost_search_instagram_audio.",
              }),
              title: Type.Optional(
                Type.String({ maxLength: 255, description: "Track title, shown in the approval prompt and stored for display." }),
              ),
              artist: Type.Optional(
                Type.String({ maxLength: 255, description: "Artist or creator, shown in the approval prompt and stored for display." }),
              ),
              audioVolume: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 100, description: "Volume of the added audio, 1 to 100. Defaults to 100." }),
              ),
              videoVolume: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 100, description: "Volume of the video's own sound, 1 to 100. Defaults to 100." }),
              ),
            },
            {
              description:
                "Music or an original sound added to a Reel. Needs contentType VIDEO, a postType other than STORY, and an account whose supportsInstagramAudio is true in adaptlypost_accounts.",
            },
          ),
        ),
      }),
      {
        description:
          "Instagram per-connection config. postType STORY takes IMAGE, VIDEO or CAROUSEL; a CAROUSEL story publishes each item as its own story, in order.",
      },
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
        shareToStory: Type.Optional(
          Type.Boolean({
            description:
              "Also publish the same media as a story next to the FEED or REEL post. The story skips the caption, video title and text background, needs IMAGE, VIDEO or CAROUSEL, and a video must be 60 seconds or shorter. Ignored when postType is STORY.",
          }),
        ),
        textFormatPresetId: Type.Optional(
          Type.String({
            pattern: "^\\d{1,20}$",
            description:
              "Facebook's id for a colored text background, for example 106018623298955 (solid purple) or 249307305544279 (red to blue gradient). Only for contentType TEXT with no media and text up to 130 characters. Links show without a preview. If Facebook refuses the background, the post goes out as plain text.",
          }),
        ),
        imageLayout: Type.Optional(
          Type.Union([Type.Literal("GRID"), Type.Literal("CAROUSEL")], {
            description:
              "GRID (default) posts the images as a photo grid. CAROUSEL posts swipeable cards, each opening its own link from carouselCards. A carousel needs postType FEED, 2 to 5 images, no videos and one card per image; otherwise the API answers 400.",
          }),
        ),
        carouselCards: Type.Optional(
          Type.Array(
            Type.Object({
              link: Type.String({ maxLength: 2048, description: "http or https URL the card opens." }),
              title: Type.Optional(Type.String({ maxLength: 100 })),
              description: Type.Optional(Type.String({ maxLength: 200 })),
            }),
            {
              maxItems: 5,
              description:
                "One card per image, in the same order as mediaUrls. Only read when imageLayout is CAROUSEL. Facebook shows the card image and title only for links to a website the Page owns; any other link makes the post fail with a message saying so.",
            },
          ),
        ),
      }),
      {
        description:
          "Facebook per-page config. pageId must match an entry in pageIds. postType STORY takes IMAGE, VIDEO or CAROUSEL; a CAROUSEL story publishes each item as its own story.",
      },
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
        boardId: Type.Optional(
          Type.String({
            description:
              "Board id from adaptlypost_list_pinterest_boards for this connectionId; a board belongs to one Pinterest account. Not together with boardName. Leave both out to pin to a public board named AdaptlyPost, created on the Pinterest account the first time it is needed.",
          }),
        ),
        boardName: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 180,
            description:
              "The board's name on this connectionId's Pinterest account, used instead of boardId when the user named the board, so no lookup is needed. AdaptlyPost trims it and takes the single exact match, or else the single case-insensitive match. Fails with 400 when no board has the name or several boards share it (the message lists their ids; pass one as boardId), and never falls back to another board. Not together with boardId.",
          }),
        ),
        title: Type.Optional(Type.String({ maxLength: 100 })),
        link: Type.Optional(Type.String()),
      }),
    ),
  ),
  googleBusinessConfigs: Type.Optional(
    Type.Array(
      Type.Object({
        connectionId: Type.String({ description: "A location id from googleBusinessConnectionIds." }),
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
                "Button shown on the post. Every type except CALL needs callToActionUrl; CALL dials the phone number on the Business Profile.",
            },
          ),
        ),
        callToActionUrl: Type.Optional(Type.String({ description: "https URL the button opens. Ignored for CALL." })),
        eventTitle: Type.Optional(Type.String()),
        eventStart: Type.Optional(
          Type.String({
            pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
            description: "YYYY-MM-DD or YYYY-MM-DDTHH:mm in the business's local time, with no offset.",
          }),
        ),
        eventEnd: Type.Optional(
          Type.String({
            pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
            description: "YYYY-MM-DD or YYYY-MM-DDTHH:mm in the business's local time, with no offset.",
          }),
        ),
        offerCouponCode: Type.Optional(Type.String({ description: "OFFER only." })),
        offerRedeemUrl: Type.Optional(Type.String({ description: "OFFER only: https URL where the offer is redeemed." })),
        offerTerms: Type.Optional(Type.String({ description: "OFFER only: terms and conditions." })),
      }),
      {
        description:
          "Google Business Profile per-location options. Google Business Profile takes contentType TEXT or IMAGE with one JPEG or PNG image up to 5 MB, text up to 1500 characters, and no alt text.",
      },
    ),
  ),
};

const FirstComment = Type.Object({
  platform: Type.Union([
    Type.Literal("LINKEDIN"),
    Type.Literal("TWITTER"),
    Type.Literal("THREADS"),
    Type.Literal("BLUESKY"),
    Type.Literal("MASTODON"),
    Type.Literal("YOUTUBE"),
    Type.Literal("FACEBOOK"),
    Type.Literal("INSTAGRAM"),
  ]),
  text: Type.String({
    minLength: 1,
    maxLength: 10000,
    description:
      "Comment text. Limits: LINKEDIN 1250, TWITTER 280, THREADS 500, BLUESKY 300, MASTODON 500, YOUTUBE 10000, FACEBOOK 8000, INSTAGRAM 2200 characters.",
  }),
});

const PlatformThumbnail = Type.Object({
  platform: Type.Union([
    Type.Literal("YOUTUBE"),
    Type.Literal("FACEBOOK"),
    Type.Literal("LINKEDIN"),
    Type.Literal("INSTAGRAM"),
    Type.Literal("PINTEREST"),
    Type.Literal("TIKTOK"),
    Type.Literal("TELEGRAM"),
  ]),
  thumbnailUrl: Type.Optional(
    Type.String({
      description:
        "Image for this platform's thumbnail: an https URL or an image data URI. YOUTUBE, FACEBOOK, LINKEDIN, TELEGRAM, INSTAGRAM and PINTEREST take one; TIKTOK does not.",
    }),
  ),
  thumbnailTimestampMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Video frame (ms from the start) to use instead. INSTAGRAM, PINTEREST and TIKTOK take one; the image wins when both are sent.",
    }),
  ),
});

const PlatformAspectRatio = Type.Object({
  platform: Type.Union([Type.Literal("INSTAGRAM"), Type.Literal("TIKTOK")]),
  aspectRatio: Type.Union(
    [Type.Literal("SQUARE"), Type.Literal("PORTRAIT"), Type.Literal("VERTICAL"), Type.Literal("LANDSCAPE")],
    {
      description:
        "SQUARE is 1:1, PORTRAIT 4:5, VERTICAL 9:16, LANDSCAPE 1.91:1. INSTAGRAM takes SQUARE, PORTRAIT or LANDSCAPE; TIKTOK takes all four.",
    },
  ),
  fit: Type.Optional(
    Type.Union([Type.Literal("CROP"), Type.Literal("PAD")], {
      description:
        "CROP (default) cuts the image from the center; PAD keeps the whole image and fills the rest with a blurred copy.",
    }),
  ),
});

const PostParameters = Type.Object({
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
  firstComments: Type.Optional(
    Type.Array(FirstComment, {
      description:
        "A comment posted from the same account about 10 seconds after the platform publishes (60 on YouTube), one entry per platform: a comment on LinkedIn, YouTube, Facebook and Instagram, a reply on X, Threads, Bluesky and Mastodon. The platform must be in platforms. Not for private or made for kids YouTube videos or Facebook and Instagram stories. A failed comment never fails the post; adaptlypost_list_posts shows firstCommentStatus and firstCommentError per platform. A Facebook Page or Instagram account connected before Facebook and Instagram got first comments needs one reconnect, or its comment fails. On X it is not retried and costs credits like any X post on a lifetime-deal account.",
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
        'Alt text per image, in the same order as mediaUrls; use "" to skip an image. Sent to X, Bluesky, Mastodon, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500 characters). TikTok, YouTube, Telegram and videos ignore it.',
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
  thumbnailUrl: Type.Optional(
    Type.String({
      description:
        "Video thumbnail as an https URL or image data URI, used on every platform that takes one unless platformThumbnails overrides it.",
    }),
  ),
  thumbnailTimestampMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Video frame (ms) to use as the thumbnail on INSTAGRAM, PINTEREST and TIKTOK unless platformThumbnails overrides it.",
    }),
  ),
  platformThumbnails: Type.Optional(
    Type.Array(PlatformThumbnail, {
      description:
        "A different thumbnail for one platform of a VIDEO post, one entry per platform. Platforms without an entry use thumbnailUrl and thumbnailTimestampMs. Not for Facebook or Instagram stories.",
    }),
  ),
  platformAspectRatios: Type.Optional(
    Type.Array(PlatformAspectRatio, {
      description:
        "Reframe every image of an IMAGE or CAROUSEL post to one shape on INSTAGRAM or TIKTOK, one entry per platform. Not for video posts or Instagram stories. Omit a platform to keep its images as uploaded.",
    }),
  ),
  twitterKeepLinks: Type.Optional(
    Type.Boolean({
      description:
        "Keep links in the X text clickable. By default every link in X text is broken (example.com becomes example. com) because X charges over 10 times more for a post with a link. Only AppSumo lifetime deals can turn this on, and a kept link costs 20 credits instead of 2; true on any other plan is a 400. Ignored when the X text has no link.",
    }),
  ),
  recurrence: Type.Optional(Recurrence),
  ...ConnectionIdFields,
  ...PlatformConfigFields,
});

export default definePluginEntry({
  id: "adaptlypost",
  name: "AdaptlyPost",
  description:
    "Schedule and publish social posts to LinkedIn, X, Instagram, Facebook, TikTok, YouTube, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile and Telegram, and read how they performed.",
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
        "List the social accounts connected to the token's workspace across all twelve platforms you can post to. Returns { accounts } with id, platform, displayName, username, avatarUrl, status, pageId for Facebook pages, and supportsInstagramAudio for Instagram accounts. For a Pinterest account, adaptlypost_list_pinterest_boards returns the boards it can pin to. A Google Business Profile account (platform GOOGLE_BUSINESS) is one location: displayName is its title and username is empty. A Telegram account (platform TELEGRAM) is a channel or group: displayName is the chat title, username is its public @username without the @ (empty for a private chat) and avatarUrl is empty. A Telegram chat can only be connected in the AdaptlyPost app, not through this plugin. Call this before adaptlypost_create_post: it takes these ids, never usernames. Put each id in the array for its platform (linkedinConnectionIds, tiktokConnectionIds, and so on); Facebook page accounts go in pageIds, Google Business Profile locations in googleBusinessConnectionIds, Telegram chats in telegramConnectionIds. status is active or unauthorized; an unauthorized account stays listed but its platform rejected the stored token (unauthorizedReason says why) and adaptlypost_create_post refuses it with 400, so skip it and tell the user to reconnect it in the dashboard, then adaptlypost_check_account to confirm. Not for post history or publishing status: use adaptlypost_list_posts or adaptlypost_post_results for those. Takes no arguments.",
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
      name: REMOVE_ACCOUNT_TOOL,
      label: "AdaptlyPost: remove an account",
      description:
        "Disconnect a social account from the token's workspace, the same as removing it on the Connectors page: its stored login is deleted, pending and recurring posts stop publishing to it, and it stops counting toward the plan. Works on unauthorized accounts too, so use it when the user wants a disabled account cleaned up rather than reconnected. For a Facebook page only that page goes; other pages from the same login stay. A removed Telegram chat stops getting posts, but the bot stays in the chat until someone removes it in Telegram. Irreversible, so every call pauses for the user's approval; bringing the account back means connecting it again in the AdaptlyPost app. Needs an Admin key; other roles are refused before the prompt. Returns { id, platform, displayName, pageId, removed: true }.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "The account id from adaptlypost_accounts (or the Facebook pageId).",
        }),
      }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, REMOVE_ACCOUNT_TOOL, params);
        const { account_id: accountId } = params as { account_id: string };
        return jsonResult(
          await callApi(cfg(), "DELETE", `/social-accounts/${encodeURIComponent(accountId)}`, { signal }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_search_instagram_audio",
      label: "AdaptlyPost: search Instagram audio",
      description:
        "Search Instagram music and original sounds to add to a Reel. Only works for an Instagram account whose supportsInstagramAudio is true in adaptlypost_accounts (connected through Facebook); other accounts get a 400, as does a search Instagram rejects. Leave out searchQuery for trending audio. Returns { audio } with audioId, audioType, title, displayArtist (music), igUsername (original sounds), durationMs, coverArtworkUrl, profilePictureUrl, previewUrl (expires after about 1.5 days), instagramUrl and isAdsEligible. Pass the chosen audioId, with its title and artist, as instagramConfigs[].audio in adaptlypost_create_post. Only audio Meta cleared for third-party publishing is returned, which can differ from what the Instagram app shows.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Instagram account id from adaptlypost_accounts with supportsInstagramAudio true.",
        }),
        audioType: Type.Union([Type.Literal("music"), Type.Literal("original_sound")], {
          description: "music for licensed tracks, original_sound for sounds from other Instagram posts.",
        }),
        searchQuery: Type.Optional(
          Type.String({ maxLength: 100, description: "Keyword filter. Leave out for trending audio." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const { account_id: accountId, ...query } = params as {
          account_id: string;
          audioType: string;
          searchQuery?: string;
        };
        return jsonResult(
          await callApi(cfg(), "GET", `/social-accounts/${encodeURIComponent(accountId)}/instagram-audio`, {
            query,
            signal,
          }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_list_pinterest_boards",
      label: "AdaptlyPost: list Pinterest boards",
      description:
        "List the boards a connected Pinterest account can pin to, secret boards included. Returns { boards } with id, name, description, privacy (PUBLIC, PROTECTED or SECRET) and pinCount. Call it before posting to Pinterest when the user has not named a board, ask which board to pin to, and pass that board's id as pinterestConfigs[].boardId in adaptlypost_create_post. When the user already named the board, skip this call and pass the name as pinterestConfigs[].boardName instead. A board belongs to one Pinterest account, so call it once per Pinterest account. A post sent without a boardId or boardName goes to a public board named AdaptlyPost, created on the Pinterest account the first time it is needed. Fails with 404 when account_id is not a Pinterest account in the token's workspace, and with 400 when Pinterest refuses the request, which usually means the user must reconnect the account in the AdaptlyPost app. Nothing is posted.",
      parameters: Type.Object({
        account_id: Type.String({
          description: "Pinterest account id from adaptlypost_accounts.",
        }),
      }),
      async execute(_toolCallId, params, signal) {
        const { account_id: accountId } = params as { account_id: string };
        return jsonResult(
          await callApi(cfg(), "GET", `/social-accounts/${encodeURIComponent(accountId)}/pinterest-boards`, {
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
        "Create one post for one or more platforms. mode is required and says what happens: DRAFT stores it for review in the AdaptlyPost app and needs no approval; SCHEDULE (with a future scheduledAt) and PUBLISH_NOW pause for the user's approval of the exact content, accounts and timing, and a denied or unanswered approval publishes nothing. Pick DRAFT whenever the user has not explicitly said to post now or at a set time, and always in unattended runs. The API key carries a workspace role: a Contributor key can only draft, so SCHEDULE and PUBLISH_NOW get 403 permission_denied from AdaptlyPost; when the plugin knows the key cannot do what was asked, the approval prompt says so and offers to save a draft instead, and the result then carries savedAsDraft: true. Publishing runs asynchronously per platform, so the response ({ postId, queuedPlatforms, skippedPlatforms, isScheduled, scheduledAt }) is not the outcome; read adaptlypost_post_results, where each platform succeeds or fails on its own. skippedPlatforms lists each platform AdaptlyPost left out of the post as { platform, reason }: when it is not empty, tell the user which platforms were skipped and why, and ask before posting again. Every account must be connected: an account whose status in adaptlypost_accounts is unauthorized makes AdaptlyPost refuse the whole post with 400, so the plugin refuses it before the approval prompt. Call adaptlypost_accounts first: each platform in platforms needs its connection-id array (linkedinConnectionIds, pageIds for Facebook, and so on), one account per platform. TikTok needs tiktokConfigs with privacyLevel. For Pinterest, pass the board the user named as boardName in pinterestConfigs, or a boardId from adaptlypost_list_pinterest_boards, never both; with neither the pin goes to a public board named AdaptlyPost. For a LinkedIn document (PDF, slides or Word file) use contentType DOCUMENT with that one file in mediaUrls and only LINKEDIN in platforms. Google Business Profile (GOOGLE_BUSINESS) takes TEXT or IMAGE with one JPEG or PNG up to 5 MB and text up to 1500 characters; set an event, offer or button with googleBusinessConfigs. Telegram (TELEGRAM) takes TEXT, IMAGE, VIDEO or CAROUSEL with text up to 4096 characters, up to 10 images (JPEG, PNG or WebP, 10 MB each) or one MP4 or MOV video up to 50 MB; a caption over 1024 characters goes out as its own message after the media, and a video takes an image thumbnail through platformThumbnails. For Instagram audio on a Reel, find an audioId with adaptlypost_search_instagram_audio. On LinkedIn, mention a company page in the text with @[Page Name](urn:li:organization:<id>). The approval prompt also shows first comments, Instagram collaborators, user tags, audio and story sharing, Google Business Profile topics and buttons, the Pinterest board, and kept X links. mediaUrls must come from adaptlypost_upload_media, or the call fails with 'Media file(s) not found in storage'. Vary the caption per platform with platformTexts when posting widely: identical text across many accounts is what spam classifiers look for. To repeat the post (every Monday, daily, monthly, yearly), add recurrence with mode SCHEDULE; the response then carries recurringPostId, and postId is the first post. A recurring post cannot be a draft or include TikTok, and only the create call takes recurrence.",
      parameters: PostParameters,
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
      name: "adaptlypost_validate_post",
      label: "AdaptlyPost: check a post without creating it",
      description:
        "Dry-run a post: takes exactly the parameters of adaptlypost_create_post and runs every check the create call runs, plus the ones that usually fail only at publish time (TikTok creator limits and video length, the YouTube upload quota, expired Instagram and Threads tokens, Mastodon attachment limits, Pinterest boards, X credits on lifetime deals). Nothing is created, uploaded or published, so it needs no approval, and any key that can draft may call it. Returns { valid, outcome, scheduledAt, requiredPermissions, issues, accounts, notChecked }. valid is false when any issue has severity ERROR, which means adaptlypost_create_post would refuse the post. outcome is what the create call would do: PUBLISH_NOW, SCHEDULED or DRAFT. accounts has one row per selected account with platform, connectionId, accountName, status (READY, WARNING or BLOCKED) and its issues; issues holds problems with the post as a whole. Each issue is { code, severity, message, platform, connectionId }: show the user message, and treat a code you do not know as opaque. notChecked lists what only the platform can decide at publish time, so mention it in one line: a valid report is not a guarantee. Call it after the user approved a post with video, TikTok, YouTube, Pinterest or X, or several accounts, then fix every ERROR with the user before calling adaptlypost_create_post with the same parameters. It is never required: adaptlypost_create_post runs the same checks and refuses a bad post with 400 post_validation_failed and the same issues.",
      parameters: PostParameters,
      async execute(_toolCallId, params, signal) {
        const body = buildPostBody(params as Record<string, unknown>);
        return jsonResult(await callApi(cfg(), "POST", "/social-posts/validate", { body, signal }));
      },
    });

    api.registerTool({
      name: "adaptlypost_list_posts",
      label: "AdaptlyPost: list posts",
      description:
        "List posts in the token's workspace, any status, newest first by default. Returns { posts, total, hasMore }; each post carries its status and a platforms array with per-platform status. Filters: statuses, platforms (posts targeting any of them), and startDate/endDate, which bound scheduledAt, or createdAt for posts never scheduled. limit is 1 to 100 (default 20); page with offset while hasMore is true. Check what is already queued before adding more: stacking several posts onto one account in a short window is the most common cause of a platform restriction. Use adaptlypost_post_results for one post's per-platform outcomes and retry ids. A post created by a recurring post carries recurringPostId and occurrenceAt (the series slot it fills); both are null on other posts.",
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
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "1 to 100, defaults to 20." })),
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
        "Take a SCHEDULED post, or a DRAFT that still has a date, off the calendar. It becomes an undated DRAFT with scheduledAt null, keeps its content, media and accounts, and nothing publishes until someone schedules it again in the AdaptlyPost app. Every call pauses for the user's approval. Unscheduling a SCHEDULED post needs a key that can schedule (Editor or Admin); a Contributor key can only unschedule its own dated drafts, and the plugin refuses a call the key cannot make before the prompt. Use it when the user wants a post pulled without deleting it; this plugin cannot reschedule, so tell the user to pick the new time in the app. Fails with 400 'Cannot edit post in current state' for any other status, and 404 for an id outside the token's workspace. Returns the post as an undated draft in the shape of adaptlypost_list_posts entries.",
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
      name: "adaptlypost_list_recurring_posts",
      label: "AdaptlyPost: list recurring posts",
      description:
        "List the recurring posts (series made by adaptlypost_create_post with recurrence) in the token's workspace. Returns { recurringPosts, total, hasMore }; each has id, status (ACTIVE, PAUSED or ENDED), pauseReason when paused, lastError, frequency, interval, weekdays, startsAt, timezone, endsOn, maxOccurrences, nextOccurrenceAt, occurrenceCount (posts created so far), the content and platforms. Only the next post of an active series exists, as a SCHEDULED post created about a day ahead; deleting that one post skips that date and the series goes on. A series pauses itself after 3 failed posts in a row (CONSECUTIVE_FAILURES), when the subscription lapses, when its creator loses workspace access, when one of its accounts is disconnected, or when a platform rejects the content. limit is 1 to 100 (default 20); page with offset while hasMore is true.",
      parameters: Type.Object({
        statuses: Type.Optional(
          Type.Array(RecurringPostStatus, { description: "Filter by series status; omit for all statuses." }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "1 to 100, defaults to 20." })),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Recurring posts to skip; increase by limit while hasMore is true.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(
          await callApi(cfg(), "GET", "/recurring-posts", {
            query: params as Record<string, unknown>,
            signal,
          }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_get_recurring_post",
      label: "AdaptlyPost: get a recurring post",
      description:
        "Get one recurring post by id, in the shape of adaptlypost_list_recurring_posts entries. Use it to see why a series paused (pauseReason, lastError) before resuming it, or what it will post next. Fails with 404 'Recurring post not found' for an id outside the token's workspace. Editing a series or skipping one date is only possible in the AdaptlyPost app.",
      parameters: Type.Object({ recurring_post_id: RecurringPostId }),
      async execute(_toolCallId, params, signal) {
        const { recurring_post_id: recurringPostId } = params as { recurring_post_id: string };
        return jsonResult(
          await callApi(cfg(), "GET", `/recurring-posts/${encodeURIComponent(recurringPostId)}`, { signal }),
        );
      },
    });

    api.registerTool({
      name: PAUSE_RECURRING_TOOL,
      label: "AdaptlyPost: pause a recurring post",
      description:
        "Pause a recurring post: it stops creating posts and its upcoming scheduled post is deleted. Dates missed while paused are skipped, never published late. Every call pauses for the user's approval. Needs an Editor or Admin key; a Contributor key is refused before the prompt. Returns the recurring post with status PAUSED and pauseReason USER. Resume it with adaptlypost_resume_recurring_post.",
      parameters: Type.Object({ recurring_post_id: RecurringPostId }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, PAUSE_RECURRING_TOOL, params);
        const { recurring_post_id: recurringPostId } = params as { recurring_post_id: string };
        return jsonResult(
          await callApi(cfg(), "POST", `/recurring-posts/${encodeURIComponent(recurringPostId)}/pause`, { signal }),
        );
      },
    });

    api.registerTool({
      name: RESUME_RECURRING_TOOL,
      label: "AdaptlyPost: resume a recurring post",
      description:
        "Resume a paused recurring post. It continues from the next date after now; dates missed while paused are not published. Every call pauses for the user's approval, since the series starts posting its saved content again. If it paused itself, read pauseReason and lastError with adaptlypost_get_recurring_post and fix the cause first (reconnect the account, renew the subscription, fix the content). Needs an Editor or Admin key; a Contributor key is refused before the prompt. Returns the recurring post; a series whose end already passed comes back ENDED.",
      parameters: Type.Object({ recurring_post_id: RecurringPostId }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, RESUME_RECURRING_TOOL, params);
        const { recurring_post_id: recurringPostId } = params as { recurring_post_id: string };
        return jsonResult(
          await callApi(cfg(), "POST", `/recurring-posts/${encodeURIComponent(recurringPostId)}/resume`, { signal }),
        );
      },
    });

    api.registerTool({
      name: DELETE_RECURRING_TOOL,
      label: "AdaptlyPost: delete a recurring post",
      description:
        "Delete a recurring post for good: the series stops and its upcoming scheduled post is deleted. Posts that already went out are kept on AdaptlyPost and on each network. Irreversible, so every call pauses for the user's approval; prefer adaptlypost_pause_recurring_post when the user may want it back. To skip one date only, delete nothing here: the user skips it in the AdaptlyPost app. Needs an Editor or Admin key; a Contributor key is refused before the prompt. Returns { deleted: true }.",
      parameters: Type.Object({ recurring_post_id: RecurringPostId }),
      async execute(toolCallId, params, signal) {
        approvals.consume(toolCallId, DELETE_RECURRING_TOOL, params);
        const { recurring_post_id: recurringPostId } = params as { recurring_post_id: string };
        return jsonResult(
          await callApi(cfg(), "DELETE", `/recurring-posts/${encodeURIComponent(recurringPostId)}`, { signal }),
        );
      },
    });

    api.registerTool({
      name: "adaptlypost_analytics_overview",
      label: "AdaptlyPost: analytics overview",
      description:
        "Workspace-wide performance for a date window: views, likes, comments, shares, followers, posts published, average views per post and engagement rate, each as { value, previousValue, deltaPercent } against the window of the same length just before it. Use it for 'how did we do this month' and follower questions. partialMetrics names metrics some selected platform cannot report; a metric no platform reports is null, so say so rather than reporting zero. Connecting an account imports its posts from the last 180 days, and numbers refresh every few hours (lastSyncedAt says when). Google Business Profile reports only how often the location was seen (impressions); Mastodon and Telegram have no analytics. Not for delivery status: adaptlypost_post_results answers 'did it publish', this answers 'how did it do'.",
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
        "Per-post metrics for posts published inside a date window, sorted by a metric or by publish date, paginated. Use it for 'top posts', 'which post got the most comments' and 'how did post X do'. Returns { posts, total, page, limit, hasMore }; each post has platform, publishedAt, title, permalink, accountName and metrics { views, likes, comments, shares, saves, clicks, impressions, reach, engagementRate }, with null for metrics the platform does not report. Posts published outside AdaptlyPost are included with postId null. Google Business Profile posts are listed with every metric null, because Google reports only location-level impressions. Sort by VIEWS with a small limit for a top list; PUBLISHED_AT (default) for a chronological review.",
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
