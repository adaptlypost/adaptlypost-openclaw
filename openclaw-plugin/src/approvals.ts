import { createHash } from "node:crypto";
import {
  AdaptlyPostApiError,
  callApi,
  describeLocalMedia,
  describeRemoteUrl,
  keyCapabilities,
  parseRemoteUrl,
  resolveLocalMedia,
  roleLabel,
  type KeyCapabilities,
  type PluginConfig,
} from "./api.js";

export const UPLOAD_TOOL = "adaptlypost_upload_media";
export const CREATE_POST_TOOL = "adaptlypost_create_post";
export const RETRY_TOOL = "adaptlypost_retry_failed";
export const UNSCHEDULE_TOOL = "adaptlypost_unschedule_post";
export const PAUSE_RECURRING_TOOL = "adaptlypost_pause_recurring_post";
export const RESUME_RECURRING_TOOL = "adaptlypost_resume_recurring_post";
export const DELETE_RECURRING_TOOL = "adaptlypost_delete_recurring_post";
export const REMOVE_ACCOUNT_TOOL = "adaptlypost_remove_account";
export const REPLY_INBOX_COMMENT_TOOL = "adaptlypost_reply_inbox_comment";
export const HIDE_INBOX_COMMENT_TOOL = "adaptlypost_hide_inbox_comment";
export const UNHIDE_INBOX_COMMENT_TOOL = "adaptlypost_unhide_inbox_comment";
export const DELETE_INBOX_COMMENT_TOOL = "adaptlypost_delete_inbox_comment";
export const REPLY_INBOX_MENTION_TOOL = "adaptlypost_reply_inbox_mention";
export const SEND_INBOX_MESSAGE_TOOL = "adaptlypost_send_inbox_message";
export const REPLY_INBOX_REVIEW_TOOL = "adaptlypost_reply_inbox_review";
export const DELETE_INBOX_REVIEW_REPLY_TOOL = "adaptlypost_delete_inbox_review_reply";
export const GATED_TOOLS = [
  UPLOAD_TOOL,
  CREATE_POST_TOOL,
  RETRY_TOOL,
  UNSCHEDULE_TOOL,
  PAUSE_RECURRING_TOOL,
  RESUME_RECURRING_TOOL,
  DELETE_RECURRING_TOOL,
  REMOVE_ACCOUNT_TOOL,
  REPLY_INBOX_COMMENT_TOOL,
  HIDE_INBOX_COMMENT_TOOL,
  UNHIDE_INBOX_COMMENT_TOOL,
  DELETE_INBOX_COMMENT_TOOL,
  REPLY_INBOX_MENTION_TOOL,
  SEND_INBOX_MESSAGE_TOOL,
  REPLY_INBOX_REVIEW_TOOL,
  DELETE_INBOX_REVIEW_REPLY_TOOL,
] as const;

export const APPROVAL_TIMEOUT_MS = 300_000;
const GRANT_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const DESCRIPTION_LIMIT = 512;

export type PostMode = "DRAFT" | "SCHEDULE" | "PUBLISH_NOW";

export type ApprovalFallback = "draft";

export type ApprovalRequest = {
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  scope: { kind: "external-post"; target: string; visibility: "public" | "restricted" };
  /** What an approval runs instead of the call as asked, when the key cannot run it as asked. */
  fallback?: ApprovalFallback;
};

export type ApprovalGrant = { fallback?: ApprovalFallback };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(params: unknown): string {
  return createHash("sha256").update(canonicalJson(params)).digest("hex");
}

export class ApprovalLedger {
  private readonly grants = new Map<string, { digest: string; expiresAt: number; fallback?: ApprovalFallback }>();

  grant(toolCallId: string, params: unknown, fallback?: ApprovalFallback): void {
    this.grants.set(toolCallId, { digest: digest(params), expiresAt: Date.now() + GRANT_TTL_MS, fallback });
  }

  consume(toolCallId: string, toolName: string, params: unknown): ApprovalGrant {
    const grant = this.grants.get(toolCallId);
    this.grants.delete(toolCallId);
    for (const [id, entry] of this.grants) {
      if (entry.expiresAt < Date.now()) this.grants.delete(id);
    }
    if (!grant || grant.expiresAt < Date.now()) {
      throw new Error(
        `${toolName} needs a human approval for this exact call and none was recorded. Nothing was uploaded or published. Ask the user to approve the prompt OpenClaw shows, or use mode DRAFT for posts.`,
      );
    }
    if (grant.digest !== digest(params)) {
      throw new Error(
        `${toolName} arguments changed after approval, so the call was refused. Nothing was uploaded or published.`,
      );
    }
    return { fallback: grant.fallback };
  }
}

const PLATFORM_LABELS: Record<string, string> = {
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TIKTOK: "TikTok",
  PINTEREST: "Pinterest",
  THREADS: "Threads",
  BLUESKY: "Bluesky",
  TWITTER: "X",
  MASTODON: "Mastodon",
  GOOGLE_BUSINESS: "Google Business Profile",
  TELEGRAM: "Telegram",
  TUMBLR: "Tumblr",
  WORDPRESS: "WordPress",
};

const CONNECTION_FIELDS: Record<string, string> = {
  LINKEDIN: "linkedinConnectionIds",
  YOUTUBE: "youtubeConnectionIds",
  INSTAGRAM: "instagramConnectionIds",
  FACEBOOK: "pageIds",
  TIKTOK: "tiktokConnectionIds",
  PINTEREST: "pinterestConnectionIds",
  THREADS: "threadsConnectionIds",
  BLUESKY: "blueskyConnectionIds",
  TWITTER: "twitterConnectionIds",
  MASTODON: "mastodonConnectionIds",
  GOOGLE_BUSINESS: "googleBusinessConnectionIds",
  TELEGRAM: "telegramConnectionIds",
  TUMBLR: "tumblrConnectionIds",
  WORDPRESS: "wordpressConnectionIds",
};

type Account = {
  id: string;
  platform: string;
  displayName?: string;
  username?: string;
  pageId?: string;
  status?: string;
};

type AccountLabel = { name: string; unauthorized: boolean };

const ROLE_RANK: Record<string, number> = { viewer: 0, contributor: 1, editor: 2, admin: 3 };

function roleHolder(me: KeyCapabilities): string {
  const issuer = me.issuerRole ?? "";
  const narrowed = issuer in ROLE_RANK && me.role.key in ROLE_RANK && ROLE_RANK[issuer] < ROLE_RANK[me.role.key];
  return narrowed
    ? `This key has the ${me.role.name} role, but the member who created it is now a ${roleLabel(issuer)}, and that role`
    : `This key has the ${me.role.name} role, which`;
}

function lookupFailed(what: string, error: unknown): Error {
  return new Error(
    `Could not load ${what} for the approval prompt, so nothing was uploaded or published: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function fetchAccountLabels(cfg: PluginConfig): Promise<Map<string, AccountLabel>> {
  const { accounts = [] } = (await callApi(cfg, "GET", "/social-accounts", {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw lookupFailed("the connected accounts", error);
  })) as { accounts?: Account[] };
  const labels = new Map<string, AccountLabel>();
  for (const account of accounts) {
    const label = {
      name: account.username ? `@${account.username}` : (account.displayName ?? account.id),
      unauthorized: account.status === "unauthorized",
    };
    labels.set(account.id, label);
    if (account.pageId) labels.set(account.pageId, label);
  }
  return labels;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

type Recurrence = {
  frequency?: string;
  interval?: number;
  weekdays?: string[];
  endsOn?: string;
  maxOccurrences?: number;
};

const WEEKDAY_ORDER = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

const WEEKDAY_LABELS: Record<string, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

const FREQUENCY_LABELS: Record<string, { once: string; unit: string }> = {
  DAILY: { once: "daily", unit: "days" },
  WEEKLY: { once: "weekly", unit: "weeks" },
  MONTHLY: { once: "monthly", unit: "months" },
  YEARLY: { once: "yearly", unit: "years" },
};

function weekdayOf(instant: string, timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(new Date(instant)).toUpperCase();
  } catch {
    return undefined;
  }
}

export function describeRecurrence(rule: Recurrence): string {
  const frequency = String(rule.frequency);
  const labels = FREQUENCY_LABELS[frequency] ?? { once: frequency.toLowerCase(), unit: frequency.toLowerCase() };
  const interval = typeof rule.interval === "number" ? rule.interval : 1;
  const every = interval > 1 ? `every ${interval} ${labels.unit}` : labels.once;
  const weekdays = stringArray(rule.weekdays);
  const days = frequency === "WEEKLY" ? WEEKDAY_ORDER.filter((day) => weekdays.includes(day)) : [];
  const on = days.length ? ` on ${days.map((day) => WEEKDAY_LABELS[day]).join(", ")}` : "";
  const ends = nonEmpty(rule.endsOn)
    ? ` until ${rule.endsOn.slice(0, 10)}`
    : typeof rule.maxOccurrences === "number"
      ? `, ${rule.maxOccurrences} posts in total`
      : " until paused or deleted";
  return `Repeats ${every}${on}${ends}.`;
}

function recurrenceOf(params: Record<string, unknown>): Recurrence | undefined {
  return params.recurrence && typeof params.recurrence === "object" ? (params.recurrence as Recurrence) : undefined;
}

function requireValidRecurrence(mode: PostMode | undefined, params: Record<string, unknown>): void {
  if (params.recurrence === undefined) return;
  const recurrence = recurrenceOf(params);
  if (!recurrence || !nonEmpty(recurrence.frequency)) {
    throw new Error("recurrence needs a frequency: DAILY, WEEKLY or MONTHLY.");
  }
  if (mode !== "SCHEDULE") {
    throw new Error(
      "recurrence needs mode SCHEDULE with a future scheduledAt for the first post. A recurring post cannot be a draft or go out now.",
    );
  }
  if (recurrence.endsOn !== undefined && recurrence.maxOccurrences !== undefined) {
    throw new Error("recurrence takes endsOn or maxOccurrences, not both. Omit both to repeat until paused or deleted.");
  }
  if (stringArray(params.platforms).includes("TIKTOK")) {
    throw new Error("TikTok posts cannot repeat. Remove TIKTOK from platforms, or drop recurrence.");
  }
}

export function buildPostBody(params: Record<string, unknown>): Record<string, unknown> {
  const { mode, scheduledAt, ...rest } = params as { mode?: PostMode; scheduledAt?: unknown } & Record<
    string,
    unknown
  >;
  requireValidRecurrence(mode, params);

  switch (mode) {
    case "DRAFT":
      if (scheduledAt === undefined) return { ...rest, saveAsDraft: true };
      if (!nonEmpty(scheduledAt) || Number.isNaN(Date.parse(scheduledAt))) {
        throw new Error(`scheduledAt "${String(scheduledAt)}" is not a valid ISO 8601 instant.`);
      }
      return { ...rest, scheduledAt, saveAsDraft: true };
    case "SCHEDULE": {
      if (!nonEmpty(scheduledAt)) throw new Error("mode SCHEDULE needs scheduledAt as an ISO 8601 instant.");
      const at = Date.parse(scheduledAt);
      if (Number.isNaN(at)) throw new Error(`scheduledAt "${scheduledAt}" is not a valid ISO 8601 instant.`);
      if (at <= Date.now()) {
        throw new Error(
          `scheduledAt ${scheduledAt} is in the past, which would publish immediately. Pick a future time, or use mode PUBLISH_NOW if the user asked to post now.`,
        );
      }
      return { ...rest, scheduledAt };
    }
    case "PUBLISH_NOW":
      if (scheduledAt !== undefined) {
        throw new Error("mode PUBLISH_NOW cannot carry scheduledAt. Drop it, or use mode SCHEDULE.");
      }
      return rest;
    default:
      throw new Error("mode is required: DRAFT, SCHEDULE or PUBLISH_NOW.");
  }
}

type ConfigEntry = Record<string, unknown>;

function configEntries(params: Record<string, unknown>, key: string): ConfigEntry[] {
  return Array.isArray(params[key]) ? (params[key] as ConfigEntry[]) : [];
}

function platformLabel(platform: unknown): string {
  return PLATFORM_LABELS[String(platform)] ?? String(platform);
}

function handles(value: unknown): string {
  return stringArray(value)
    .map((name) => `@${name.replace(/^@/, "")}`)
    .join(", ");
}

function tagHandles(value: unknown): string {
  const tags = Array.isArray(value) ? value : [];
  return handles(tags.map((tag) => (tag && typeof tag === "object" ? (tag as ConfigEntry).username : undefined)));
}

function audioLabel(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const audio = value as ConfigEntry;
  const name = nonEmpty(audio.title) ? `"${audio.title}"${nonEmpty(audio.artist) ? ` by ${audio.artist}` : ""} ` : "";
  const volumes = [
    typeof audio.audioVolume === "number" ? `volume ${audio.audioVolume}%` : undefined,
    typeof audio.videoVolume === "number" ? `video sound ${audio.videoVolume}%` : undefined,
  ].filter(nonEmpty);
  return `audio ${name}(id ${String(audio.audioId)})${volumes.length ? `, ${volumes.join(", ")}` : ""}`;
}

function instagramLine(entry: ConfigEntry): string {
  const postType = String(entry.postType ?? "FEED");
  const parts = [postType];
  if (entry.trialGraduation === "MANUAL") parts.push("trial reel you share to followers yourself");
  if (entry.trialGraduation === "SS_PERFORMANCE") parts.push("trial reel Instagram shares if it performs well");
  if (entry.shareToStory === true && postType !== "STORY") parts.push("also shared as a story");
  const collaborators = handles(entry.collaborators);
  if (collaborators) parts.push(`collaborators ${collaborators}`);
  const tagged = tagHandles(entry.userTags);
  if (tagged) parts.push(`tags ${tagged}`);
  if (entry.aiGenerated === true) parts.push("AI info label");
  const audio = audioLabel(entry.audio);
  if (audio) parts.push(audio);
  return `Instagram: ${parts.join(", ")}`;
}

function facebookLine(entry: ConfigEntry): string {
  const postType = String(entry.postType ?? "FEED");
  const parts = [postType];
  if (nonEmpty(entry.videoTitle)) parts.push(`title "${entry.videoTitle}"`);
  if (entry.shareToStory === true && postType !== "STORY") parts.push("also shared as a story");
  if (nonEmpty(entry.textFormatPresetId)) parts.push(`colored background ${entry.textFormatPresetId}`);
  if (entry.imageLayout === "CAROUSEL") parts.push(carouselLabel(entry.carouselCards));
  if (entry.aiGenerated === true) parts.push("AI info label");
  return `Facebook: ${parts.join(", ")}`;
}

function tiktokExtras(entry: ConfigEntry): string {
  const parts = [
    entry.allowComments === false ? "comments off" : undefined,
    entry.allowDuet === false ? "duets off" : undefined,
    entry.allowStitch === false ? "stitches off" : undefined,
    entry.brandedContent === true ? "branded content" : undefined,
    entry.brandedContentOwnBrand === true ? "promotes own brand" : undefined,
    entry.autoAddMusic === true ? "auto music" : undefined,
    entry.aiGenerated === true ? "AI-generated label" : undefined,
  ].filter(nonEmpty);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

function youtubeExtras(entry: ConfigEntry): string {
  const tags = stringArray(entry.tags);
  const parts = [
    tags.length ? `tags ${tags.join(", ")}` : undefined,
    nonEmpty(entry.playlistId) ? `playlist ${entry.playlistId}` : undefined,
    nonEmpty(entry.categoryId) ? `category ${entry.categoryId}` : undefined,
    entry.license === "creativeCommon" ? "Creative Commons license" : undefined,
    entry.notifySubscribers === false ? "no subscriber notification" : undefined,
    entry.allowEmbedding === false ? "embedding off" : undefined,
    entry.scheduleOnYouTube === true
      ? "uploaded now as a private video that YouTube publishes at the scheduled time"
      : undefined,
  ].filter(nonEmpty);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

function carouselLabel(value: unknown): string {
  const cards = Array.isArray(value) ? (value as ConfigEntry[]) : [];
  const links = cards.map((card, index) => `card ${index + 1} ${String(card.link ?? "(no link)")}`);
  return `link carousel${links.length ? `: ${links.join(", ")}` : " with no cards"}`;
}

function googleBusinessLine(entry: ConfigEntry): string {
  const parts = [String(entry.topicType ?? "STANDARD")];
  if (nonEmpty(entry.eventTitle)) parts.push(`"${entry.eventTitle}"`);
  if (nonEmpty(entry.eventStart) || nonEmpty(entry.eventEnd)) {
    parts.push(`${String(entry.eventStart ?? "?")} to ${String(entry.eventEnd ?? "?")}`);
  }
  if (nonEmpty(entry.callToActionType)) {
    const url = entry.callToActionType !== "CALL" && nonEmpty(entry.callToActionUrl) ? ` ${entry.callToActionUrl}` : "";
    parts.push(`button ${entry.callToActionType}${url}`);
  }
  if (nonEmpty(entry.offerCouponCode)) parts.push(`code ${entry.offerCouponCode}`);
  if (nonEmpty(entry.offerRedeemUrl)) parts.push(`redeem at ${entry.offerRedeemUrl}`);
  if (nonEmpty(entry.offerTerms)) parts.push(`terms "${entry.offerTerms}"`);
  return `Google Business Profile: ${parts.join(", ")}`;
}

function tumblrLine(entry: ConfigEntry): string | undefined {
  const parts: string[] = [];
  if (nonEmpty(entry.title)) parts.push(`title "${entry.title}"`);
  const tags = stringArray(entry.tags);
  if (tags.length) parts.push(`tags ${tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(", ")}`);
  if (nonEmpty(entry.sourceUrl)) parts.push(`source ${entry.sourceUrl}`);
  return parts.length ? `Tumblr: ${parts.join(", ")}` : undefined;
}

const WORDPRESS_STATUS_LABELS: Record<string, string> = {
  DRAFT: "left as a draft on the site, not published",
  PENDING: "submitted for review on the site, not published",
};

function wordpressLine(entry: ConfigEntry): string | undefined {
  const parts: string[] = [];
  if (nonEmpty(entry.title)) parts.push(`title "${entry.title}"`);
  if (nonEmpty(entry.excerpt)) parts.push(`excerpt "${entry.excerpt}"`);
  const categoryIds = Array.isArray(entry.categoryIds) ? entry.categoryIds.map(String) : [];
  if (categoryIds.length) parts.push(`category ids ${categoryIds.join(", ")}`);
  const tags = stringArray(entry.tags);
  if (tags.length) parts.push(`tags ${tags.join(", ")}`);
  const status = typeof entry.status === "string" ? WORDPRESS_STATUS_LABELS[entry.status] : undefined;
  if (status) parts.push(status);
  return parts.length ? `WordPress: ${parts.join(", ")}` : undefined;
}

const DEFAULT_PINTEREST_BOARD = 'public "AdaptlyPost" board that is created if missing';

function pinterestLines(params: Record<string, unknown>): string[] {
  if (!stringArray(params.platforms).includes("PINTEREST")) return [];
  const configs = configEntries(params, "pinterestConfigs");
  return stringArray(params.pinterestConnectionIds).map((connectionId) => {
    const entry = configs.find((config) => config.connectionId === connectionId) ?? {};
    const board = nonEmpty(entry.boardName)
      ? `board "${entry.boardName}"`
      : nonEmpty(entry.boardId)
        ? `board ${entry.boardId}`
        : DEFAULT_PINTEREST_BOARD;
    return `Pinterest: ${board}${nonEmpty(entry.title) ? `, title "${entry.title}"` : ""}${nonEmpty(entry.link) ? `, link ${entry.link}` : ""}`;
  });
}

function settingLines(params: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const entry of configEntries(params, "tiktokConfigs")) {
    lines.push(
      `TikTok: ${String(entry.privacyLevel)}${entry.sendAsDraft ? ", sent to TikTok drafts" : ""}${tiktokExtras(entry)}${nonEmpty(entry.title) ? `, title "${entry.title}"` : ""}`,
    );
  }
  for (const entry of configEntries(params, "youtubeConfigs")) {
    lines.push(
      `YouTube: ${String(entry.privacyStatus ?? "public")} ${String(entry.postType ?? "VIDEO")}${entry.madeForKids ? ", made for kids" : ""}${entry.aiGenerated === true ? ", altered or synthetic content label" : ""}${nonEmpty(entry.defaultAudioLanguage) ? `, audio language ${entry.defaultAudioLanguage}` : ""}${youtubeExtras(entry)}${nonEmpty(entry.videoTitle) ? `, title "${entry.videoTitle}"` : ""}`,
    );
  }
  for (const entry of configEntries(params, "instagramConfigs")) lines.push(instagramLine(entry));
  for (const entry of configEntries(params, "facebookConfigs")) lines.push(facebookLine(entry));
  for (const entry of configEntries(params, "googleBusinessConfigs")) lines.push(googleBusinessLine(entry));
  for (const entry of configEntries(params, "tumblrConfigs")) {
    const line = tumblrLine(entry);
    if (line) lines.push(line);
  }
  for (const entry of configEntries(params, "wordpressConfigs")) {
    const line = wordpressLine(entry);
    if (line) lines.push(line);
  }
  for (const entry of configEntries(params, "linkedinConfigs")) {
    if (nonEmpty(entry.documentTitle)) lines.push(`LinkedIn: document title "${entry.documentTitle}"`);
    if (nonEmpty(entry.reshareOf)) lines.push(`LinkedIn: reshares ${entry.reshareOf} with the text as commentary`);
  }
  for (const entry of configEntries(params, "twitterConfigs")) {
    if (nonEmpty(entry.quoteOf)) lines.push(`X: quotes ${entry.quoteOf} with the text as commentary`);
  }
  lines.push(...pinterestLines(params));
  if (params.twitterKeepLinks === true && stringArray(params.platforms).includes("TWITTER")) {
    lines.push("X: links stay clickable, costing 20 credits instead of 2");
  }
  for (const entry of configEntries(params, "platformAspectRatios")) {
    lines.push(`${platformLabel(entry.platform)} images: ${String(entry.aspectRatio)}, ${entry.fit === "PAD" ? "padded" : "cropped"}`);
  }
  for (const entry of configEntries(params, "platformThumbnails")) {
    const thumbnail = nonEmpty(entry.thumbnailUrl)
      ? fileName(entry.thumbnailUrl)
      : `frame at ${String(entry.thumbnailTimestampMs)} ms`;
    lines.push(`${platformLabel(entry.platform)} thumbnail: ${thumbnail}`);
  }
  return lines;
}

function platformMediaLines(params: Record<string, unknown>): string[] {
  return configEntries(params, "platformMedia").map((entry) => {
    const media = stringArray(entry.mediaUrls).map(fileName);
    const altTextCount = stringArray(entry.mediaAltTexts).filter((altText) => altText.trim()).length;
    return `${platformLabel(entry.platform)} gets its own media: ${media.join(", ")}${altTextCount ? `, alt text on ${altTextCount} of ${media.length}` : ""}`;
  });
}

function firstCommentLines(params: Record<string, unknown>): string[] {
  return configEntries(params, "firstComments").map(
    (entry) => `${platformLabel(entry.platform)} first comment: "${String(entry.text ?? "")}"`,
  );
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function threadLines(heading: string, texts: unknown, mediaUrls: unknown, indent: string): string[] {
  const replies = stringArray(texts);
  if (!replies.length) return [];
  const images = (Array.isArray(mediaUrls) ? mediaUrls : []).map((urls) => stringArray(urls).length);
  const totalImages = images.reduce((sum, count) => sum + count, 0);
  return [
    `${heading}: ${counted(replies.length, "reply", "replies")}, ${counted(totalImages, "image", "images")}`,
    ...replies.map((text, index) => {
      const replyImages = images[index] ? `, ${counted(images[index], "image", "images")}` : "";
      return `${indent}Reply ${index + 1}: ${nonEmpty(text) ? `"${text}"` : "(no text)"}${replyImages}`;
    }),
  ];
}

function threadReplyLines(params: Record<string, unknown>): string[] {
  return configEntries(params, "threadReplies").flatMap((entry) =>
    threadLines(`${platformLabel(entry.platform)} thread`, entry.texts, entry.mediaUrls, "  "),
  );
}

function fileName(url: string): string {
  if (url.startsWith("data:")) return "an image sent inline";
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

function textLines(params: Record<string, unknown>): string[] {
  const lines = nonEmpty(params.text) ? [`Text: "${params.text}"`] : [];
  const overrides = Array.isArray(params.platformTexts) ? (params.platformTexts as ConfigEntry[]) : [];
  for (const entry of overrides) {
    const platform = String(entry.platform);
    lines.push(`${PLATFORM_LABELS[platform] ?? platform} text: "${String(entry.text ?? "")}"`);
  }
  return lines.length ? lines : ["Text: (none)"];
}

function requireFullPrompt(title: string, lines: string[], ifTooLong: string): string {
  const description = lines.join("\n");
  if (description.length > DESCRIPTION_LIMIT) {
    throw new Error(
      `${title}: the approval prompt must show everything that will go public, and this call needs ${description.length} characters where the prompt holds ${DESCRIPTION_LIMIT}. Nothing was uploaded or published. ${ifTooLong}`,
    );
  }
  return description;
}

function refusedAction(me: KeyCapabilities | undefined, publishNow: boolean): string | undefined {
  if (!me) return undefined;
  if (publishNow && !me.can.publish) return "publish";
  if (!publishNow && !me.can.schedule) return "schedule";
  return undefined;
}

function withFirstWeekday(recurrence: Recurrence, scheduledAt: string, timezone: string): Recurrence {
  if (recurrence.frequency !== "WEEKLY") return recurrence;
  const first = weekdayOf(scheduledAt, timezone);
  const weekdays = stringArray(recurrence.weekdays);
  return first && !weekdays.includes(first) ? { ...recurrence, weekdays: [...weekdays, first] } : recurrence;
}

async function describePost(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest | undefined> {
  const body = buildPostBody(params);
  if (params.mode === "DRAFT") return undefined;

  const platforms = stringArray(params.platforms);
  const [labels, me] = await Promise.all([
    fetchAccountLabels(cfg),
    keyCapabilities(cfg, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)),
  ]);
  const disconnected: string[] = [];
  const targets = platforms.flatMap((platform) =>
    stringArray(params[CONNECTION_FIELDS[platform] ?? ""]).map((id) => {
      const label = labels.get(id);
      if (!label) {
        throw new Error(
          `Account ${id} for ${PLATFORM_LABELS[platform] ?? platform} is not among the connected accounts, so the approval prompt cannot name it. Nothing was published. Take ids from adaptlypost_accounts.`,
        );
      }
      const target = `${PLATFORM_LABELS[platform] ?? platform} ${label.name}`;
      if (label.unauthorized) disconnected.push(target);
      return target;
    }),
  );
  if (!targets.length) throw new Error("No connection ids were given for the selected platforms. Nothing was published.");
  if (disconnected.length) {
    throw new Error(
      `${disconnected.join(", ")} ${disconnected.length === 1 ? "is" : "are"} disconnected (status unauthorized), and AdaptlyPost refuses a post to a disconnected account with 400. Nothing was published. Ask the user to reconnect ${disconnected.length === 1 ? "it" : "them"} in the AdaptlyPost app, or leave ${disconnected.length === 1 ? "it" : "them"} out of the call.`,
    );
  }

  const publishNow = params.mode === "PUBLISH_NOW";
  const refused = refusedAction(me, publishNow);
  const recurrence = recurrenceOf(params);
  if (refused && recurrence && me) {
    throw new Error(
      `${roleHolder(me)} cannot schedule, and a recurring post cannot be saved as a draft, so nothing was created. Save a single post with mode DRAFT instead, or ask a workspace member with an Editor or Admin role to set up the repeat in the AdaptlyPost app.`,
    );
  }
  const accountCount = `${targets.length} account${targets.length === 1 ? "" : "s"}`;
  const title = refused
    ? `Key cannot ${refused}: save as draft for ${accountCount}?`
    : `${publishNow ? "Publish now" : recurrence ? "Schedule a recurring post" : "Schedule a post"} to ${accountCount}`;
  const media = stringArray(params.mediaUrls).map(fileName);
  const altTextCount = stringArray(params.mediaAltTexts).filter((altText) => altText.trim()).length;
  const timing = publishNow
    ? "Publishes immediately and cannot be recalled."
    : `${recurrence ? "First post" : "Scheduled for"} ${String(body.scheduledAt)}${nonEmpty(params.timezone) ? ` (${params.timezone})` : ""}.`;
  const lines = [
    refused && me
      ? `AdaptlyPost will refuse to ${refused}. ${roleHolder(me)} cannot ${refused}. Approve to save the post below as a draft for a workspace member to ${refused}; deny to do nothing.`
      : timing,
    ...(recurrence ? [describeRecurrence(withFirstWeekday(recurrence, String(body.scheduledAt), nonEmpty(params.timezone) ? params.timezone : "UTC"))] : []),
    `Accounts: ${targets.join(", ")}`,
    ...settingLines(params),
    ...(media.length ? [`Media: ${media.join(", ")}`] : []),
    ...(altTextCount ? [`Alt text on ${altTextCount} of ${media.length} images`] : []),
    ...platformMediaLines(params),
    ...(nonEmpty(params.thumbnailUrl) ? [`Thumbnail: ${fileName(params.thumbnailUrl)}`] : []),
    ...textLines(params),
    ...firstCommentLines(params),
    ...threadReplyLines(params),
  ];

  return {
    title,
    description: requireFullPrompt(
      title,
      lines,
      "Save it with mode DRAFT and let the user review and publish it in the AdaptlyPost app, or post to fewer accounts per call.",
    ),
    severity: refused ? "warning" : publishNow ? "critical" : "warning",
    scope: {
      kind: "external-post",
      target: platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(", "),
      visibility: refused ? "restricted" : "public",
    },
    ...(refused && { fallback: "draft" as const }),
  };
}

async function describeUpload(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest> {
  const filePaths = stringArray(params.file_paths);
  const urls = stringArray(params.urls);
  if (!filePaths.length && !urls.length) throw new Error("Provide at least one of file_paths or urls.");

  const files = await Promise.all(filePaths.map((path) => resolveLocalMedia(cfg, path)));
  const remotes = urls.map(parseRemoteUrl);
  const count = files.length + remotes.length;
  const title = `Upload ${count} media file${count === 1 ? "" : "s"} to public storage`;
  const lines = [
    "Each file gets a public URL as soon as it is stored, even if no post uses it.",
    ...files.map((file) => `File: ${describeLocalMedia(file)}`),
    ...remotes.map((url) => `Download and re-host: ${url.href}`),
  ];

  return {
    title,
    description: requireFullPrompt(title, lines, "Upload fewer files per call, one at a time if needed."),
    severity: "warning",
    scope: { kind: "external-post", target: "AdaptlyPost media storage", visibility: "public" },
  };
}

type ResultRow = { platformId: string; platform: string; accountName?: string; status: string };
type PostPlatform = ConfigEntry & { id: string; platform: string };
type PostRecord = { text?: string; platforms?: PostPlatform[] };

function platformEntryLines(entry: PostPlatform, fallbackText: string | undefined): string[] {
  const label = PLATFORM_LABELS[entry.platform] ?? entry.platform;
  const settings = [
    entry.tiktokPrivacyLevel,
    entry.youtubePrivacyStatus,
    entry.instagramPostType,
    entry.facebookPostType,
    entry.googleBusinessTopicType,
    nonEmpty(entry.pinterestBoardId)
      ? `board ${entry.pinterestBoardId}`
      : entry.platform === "PINTEREST"
        ? DEFAULT_PINTEREST_BOARD
        : undefined,
    stringArray(entry.instagramCollaborators).length ? `collaborators ${handles(entry.instagramCollaborators)}` : undefined,
    tagHandles(entry.instagramUserTags) ? `tags ${tagHandles(entry.instagramUserTags)}` : undefined,
    entry.instagramAiGenerated === true ? "AI info label" : undefined,
    entry.youtubeAiGenerated === true ? "altered or synthetic content label" : undefined,
    entry.facebookAiGenerated === true ? "AI info label" : undefined,
    entry.facebookImageLayout === "CAROUSEL" ? carouselLabel(entry.facebookCarouselCards) : undefined,
    nonEmpty(entry.instagramAudioId)
      ? `audio ${nonEmpty(entry.instagramAudioTitle) ? `"${entry.instagramAudioTitle}"` : entry.instagramAudioId}`
      : undefined,
    nonEmpty(entry.googleBusinessCallToActionType)
      ? `button ${entry.googleBusinessCallToActionType}${nonEmpty(entry.googleBusinessCallToActionUrl) && entry.googleBusinessCallToActionType !== "CALL" ? ` ${entry.googleBusinessCallToActionUrl}` : ""}`
      : undefined,
    entry.twitterKeepLinks === true ? "links stay clickable" : undefined,
    nonEmpty(entry.twitterQuoteOf) ? `quotes ${entry.twitterQuoteOf}` : undefined,
    nonEmpty(entry.linkedinReshareOf) ? `reshares ${entry.linkedinReshareOf}` : undefined,
  ].filter(nonEmpty);
  const titles = [
    entry.tiktokTitle,
    entry.youtubeVideoTitle,
    entry.facebookVideoTitle,
    entry.pinterestTitle,
    entry.googleBusinessEventTitle,
  ].filter(nonEmpty);
  const media = stringArray(entry.mediaUrls).map(fileName);
  const text = nonEmpty(entry.text) ? entry.text : fallbackText;
  return [
    `${label} ${String(entry.accountName ?? entry.id)}${settings.length ? ` (${settings.join(", ")})` : ""}`,
    ...titles.map((title) => `  Title: "${title}"`),
    ...(nonEmpty(entry.pinterestLink) ? [`  Link: ${entry.pinterestLink}`] : []),
    ...(media.length ? [`  Media: ${media.join(", ")}`] : []),
    `  Text: ${nonEmpty(text) ? `"${text}"` : "(none)"}`,
    ...(nonEmpty(entry.firstComment) ? [`  First comment: "${entry.firstComment}"`] : []),
    ...threadLines("  Thread", entry.threadReplies, entry.threadReplyMediaUrls, "    "),
  ];
}

async function describeRetry(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest> {
  const postId = String(params.post_id ?? "");
  const platformIds = stringArray(params.platform_ids);
  const path = `/social-posts/${encodeURIComponent(postId)}`;
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const me = await keyCapabilities(cfg, signal);
  if (me && !me.can.publish) {
    throw new Error(
      `${roleHolder(me)} cannot publish, so AdaptlyPost would refuse the retry with 403 permission_denied. Nothing was retried. Tell the user a workspace member with an Editor or Admin role has to retry it in the AdaptlyPost app, or give the agent a key with that role.`,
    );
  }
  const [post, results] = await Promise.all([
    callApi(cfg, "GET", path, { signal }) as Promise<PostRecord>,
    callApi(cfg, "GET", `${path}/results`, { signal }) as Promise<{ results?: ResultRow[] }>,
  ]).catch((error: unknown) => {
    throw lookupFailed(`post ${postId}`, error);
  });

  const targeted = (row: ResultRow) =>
    platformIds.length === 0 || platformIds.includes(row.platformId) || platformIds.includes(row.platform);
  const failedIds = new Set(
    (results.results ?? [])
      .filter((row) => targeted(row) && row.status === "FAILED")
      .map((row) => row.platformId),
  );
  const entries = (post.platforms ?? []).filter((entry) => failedIds.has(entry.id));
  if (!entries.length || entries.length !== failedIds.size) {
    throw new Error("No FAILED platform of this post matches platform_ids, so nothing can be shown for approval. Nothing was retried.");
  }

  const title = `Retry publishing on ${entries.length} platform${entries.length === 1 ? "" : "s"}`;
  const lines = [
    "Re-publishes the saved content below immediately. It cannot be recalled.",
    ...entries.flatMap((entry) => platformEntryLines(entry, post.text)),
  ];

  return {
    title,
    description: requireFullPrompt(
      title,
      lines,
      "Retry one platform per call, or let the user retry it from the AdaptlyPost app.",
    ),
    severity: "critical",
    scope: {
      kind: "external-post",
      target: entries.map((entry) => PLATFORM_LABELS[entry.platform] ?? entry.platform).join(", "),
      visibility: "public",
    },
  };
}

const UNSCHEDULE_TEXT_PREVIEW = 120;

async function describeUnschedule(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest> {
  const postId = String(params.post_id ?? "");
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const [post, me] = await Promise.all([
    callApi(cfg, "GET", `/social-posts/${encodeURIComponent(postId)}`, { signal }).catch((error: unknown) => {
      throw lookupFailed(`post ${postId}`, error);
    }) as Promise<PostRecord & { status?: string; scheduledAt?: string | null }>,
    keyCapabilities(cfg, signal),
  ]);
  const isDraft = post.status === "DRAFT";
  if (me && !(isDraft ? me.can.draft : me.can.schedule)) {
    throw new Error(
      `${roleHolder(me)} cannot ${isDraft ? "edit drafts" : "change scheduled posts"}, so AdaptlyPost would refuse to unschedule this ${isDraft ? "draft" : `${(post.status ?? "scheduled").toLowerCase()} post`} with 403 permission_denied. Nothing was changed. Tell the user a workspace member with an Editor or Admin role has to unschedule it in the AdaptlyPost app, or give the agent a key with that role.`,
    );
  }

  const platforms = post.platforms ?? [];
  const accounts = platforms.map(
    (entry) => `${PLATFORM_LABELS[entry.platform] ?? entry.platform} ${String(entry.accountName ?? entry.id)}`,
  );
  const text = nonEmpty(post.text) ? post.text : undefined;
  const preview = text && text.length > UNSCHEDULE_TEXT_PREVIEW ? `${text.slice(0, UNSCHEDULE_TEXT_PREVIEW)}…` : text;
  const lines = [
    post.scheduledAt
      ? `Cancels the publication planned for ${post.scheduledAt}. The post stays as an undated draft with its content and accounts.`
      : "The post stays as an undated draft with its content and accounts.",
    ...(accounts.length ? [`Accounts: ${accounts.join(", ")}`] : []),
    `Text: ${preview ? `"${preview}"` : "(none)"}`,
  ];

  return {
    title: "Unschedule a post",
    description: lines.join("\n").slice(0, DESCRIPTION_LIMIT),
    severity: "warning",
    scope: {
      kind: "external-post",
      target: platforms.map((entry) => PLATFORM_LABELS[entry.platform] ?? entry.platform).join(", ") || postId,
      visibility: "restricted",
    },
  };
}

type RecurringPostRecord = PostRecord &
  Recurrence & {
    status?: string;
    pauseReason?: string;
    occurrenceCount?: number;
    mediaUrls?: string[];
  };

type SeriesChange = {
  verb: string;
  effect: string;
  allowed: (me: KeyCapabilities) => boolean;
  showsContent: boolean;
  severity: ApprovalRequest["severity"];
  visibility: ApprovalRequest["scope"]["visibility"];
};

const SERIES_CHANGES: Record<string, SeriesChange> = {
  [PAUSE_RECURRING_TOOL]: {
    verb: "Pause",
    effect:
      "Stops the series and deletes its upcoming scheduled post. Dates missed while paused are skipped, not published later.",
    allowed: (me) => me.can.schedule,
    showsContent: false,
    severity: "warning",
    visibility: "restricted",
  },
  [RESUME_RECURRING_TOOL]: {
    verb: "Resume",
    effect: "Posts the content below again from the next date after now. Dates missed while paused stay skipped.",
    allowed: (me) => me.can.schedule,
    showsContent: true,
    severity: "warning",
    visibility: "public",
  },
  [DELETE_RECURRING_TOOL]: {
    verb: "Delete",
    effect:
      "Stops the series for good and deletes its upcoming scheduled post. Posts already published stay up. This cannot be undone.",
    allowed: (me) => !Array.isArray(me.permissions) || me.permissions.includes("posts.delete"),
    showsContent: false,
    severity: "critical",
    visibility: "restricted",
  },
};

function seriesStateLine(series: RecurringPostRecord): string {
  const count = typeof series.occurrenceCount === "number" ? ` ${series.occurrenceCount} posts so far.` : "";
  const status =
    series.status && series.status !== "ACTIVE"
      ? ` Status: ${series.status}${nonEmpty(series.pauseReason) ? ` (${series.pauseReason})` : ""}.`
      : "";
  return `${describeRecurrence(series)}${count}${status}`;
}

async function describeSeriesChange(
  cfg: PluginConfig,
  toolName: string,
  params: Record<string, unknown>,
): Promise<ApprovalRequest> {
  const change = SERIES_CHANGES[toolName];
  const recurringPostId = String(params.recurring_post_id ?? "");
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const me = await keyCapabilities(cfg, signal);
  if (me && !change.allowed(me)) {
    throw new Error(
      `${roleHolder(me)} cannot ${change.verb.toLowerCase()} recurring posts, so AdaptlyPost would refuse with 403 permission_denied. Nothing was changed. Tell the user a workspace member with an Editor or Admin role has to do it in the AdaptlyPost app, or give the agent a key with that role.`,
    );
  }
  const series = (await callApi(cfg, "GET", `/recurring-posts/${encodeURIComponent(recurringPostId)}`, {
    signal,
  }).catch((error: unknown) => {
    throw lookupFailed(`recurring post ${recurringPostId}`, error);
  })) as RecurringPostRecord;

  const platforms = series.platforms ?? [];
  const accounts = platforms.map(
    (entry) => `${PLATFORM_LABELS[entry.platform] ?? entry.platform} ${String(entry.accountName ?? entry.id)}`,
  );
  const title = `${change.verb} a recurring post`;
  const header = [change.effect, seriesStateLine(series), ...(accounts.length ? [`Accounts: ${accounts.join(", ")}`] : [])];
  const target = platforms.map((entry) => PLATFORM_LABELS[entry.platform] ?? entry.platform).join(", ") || recurringPostId;
  const scope = { kind: "external-post" as const, target, visibility: change.visibility };

  if (!change.showsContent) {
    const text = nonEmpty(series.text) ? series.text : undefined;
    const preview = text && text.length > UNSCHEDULE_TEXT_PREVIEW ? `${text.slice(0, UNSCHEDULE_TEXT_PREVIEW)}…` : text;
    return {
      title,
      description: [...header, `Text: ${preview ? `"${preview}"` : "(none)"}`].join("\n").slice(0, DESCRIPTION_LIMIT),
      severity: change.severity,
      scope,
    };
  }

  const media = stringArray(series.mediaUrls).map(fileName);
  const overrides = platforms
    .filter((entry) => nonEmpty(entry.text) && entry.text !== series.text)
    .map((entry) => `${PLATFORM_LABELS[entry.platform] ?? entry.platform} text: "${String(entry.text)}"`);
  const lines = [
    ...header,
    ...(media.length ? [`Media: ${media.join(", ")}`] : []),
    `Text: ${nonEmpty(series.text) ? `"${series.text}"` : "(none)"}`,
    ...overrides,
  ];
  return {
    title,
    description: requireFullPrompt(title, lines, "Let the user resume it from the AdaptlyPost app."),
    severity: change.severity,
    scope,
  };
}

type ConnectedAccount = {
  id: string;
  platform: string;
  displayName?: string;
  username?: string;
  pageId?: string;
  status?: string;
};

async function describeAccountRemoval(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest> {
  const accountId = String(params.account_id ?? "");
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const me = await keyCapabilities(cfg, signal);
  if (me && Array.isArray(me.permissions) && !me.permissions.includes("accounts.manage")) {
    throw new Error(
      `${roleHolder(me)} cannot disconnect accounts, so AdaptlyPost would refuse with 403 permission_denied. Nothing was changed. Tell the user a workspace Admin has to remove it on the Connectors page in the AdaptlyPost app, or give the agent an Admin key.`,
    );
  }
  const { accounts } = (await callApi(cfg, "GET", "/social-accounts", { signal }).catch((error: unknown) => {
    throw lookupFailed("the connected accounts", error);
  })) as { accounts: ConnectedAccount[] };
  const account = accounts.find((candidate) => candidate.id === accountId || candidate.pageId === accountId);
  if (!account) {
    throw new Error(
      `No account with id ${accountId} is connected to this workspace, so nothing was removed. Call adaptlypost_accounts for the current ids.`,
    );
  }

  const platform = PLATFORM_LABELS[account.platform] ?? account.platform;
  const name = nonEmpty(account.displayName) ? account.displayName : nonEmpty(account.username) ? account.username : account.id;
  const lines = [
    `Disconnects ${platform} ${name} from the workspace and deletes its stored login. Pending and recurring posts stop publishing to it. Posts already published stay up. Bringing it back means connecting it again in the AdaptlyPost app.`,
    ...(account.platform === "FACEBOOK" ? ["Only this page goes; other pages from the same Facebook login stay connected."] : []),
    ...(account.status ? [`Status: ${account.status}`] : []),
  ];

  return {
    title: "Remove a connected account",
    description: lines.join("\n").slice(0, DESCRIPTION_LIMIT),
    severity: "critical",
    scope: { kind: "external-post", target: platform, visibility: "restricted" },
  };
}

const INBOX_QUOTE_LIMIT = 120;
const INBOX_MIN_QUOTE = 20;
const INBOX_LIST_LOOKUP_LIMIT = 100;

type InboxPerson = { name?: string | null; username?: string | null; isAnonymous?: boolean };
type InboxCapabilities = { canReply?: boolean; canHide?: boolean; canDelete?: boolean; canLike?: boolean };
type InboxItemBase = { id: string; platform?: string; accountName?: string; capabilities?: InboxCapabilities };
type InboxCommentRecord = InboxItemBase & { author?: InboxPerson; text?: string; isHidden?: boolean };
type InboxMentionRecord = InboxItemBase & { author?: InboxPerson; text?: string };
type InboxMessageRecord = { isOwn?: boolean; text?: string | null; hasAttachments?: boolean };
type InboxConversationRecord = InboxItemBase & { participant?: InboxPerson; replyWindowEndsAt?: string | null };
type InboxReviewRecord = InboxItemBase & {
  reviewer?: InboxPerson;
  rating?: number;
  text?: string | null;
  reply?: { text?: string | null } | null;
};

type Lookup<T> = { item?: T; note?: string };

function personLabel(person: InboxPerson | undefined): string {
  if (person?.isAnonymous) return "an anonymous reviewer";
  const name = nonEmpty(person?.name) ? person.name : undefined;
  const handle = nonEmpty(person?.username) ? `@${person.username.replace(/^@/, "")}` : undefined;
  if (name && handle) return `${name} (${handle})`;
  return name ?? handle ?? "an unknown author";
}

function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat;
}

function inboxAccountLine(item: InboxItemBase | undefined): string | undefined {
  if (!item) return undefined;
  return `Account: ${platformLabel(item.platform)} ${String(item.accountName ?? "")}`.trimEnd();
}

function inboxTarget(item: InboxItemBase | undefined, fallback: string): string {
  return item?.platform ? platformLabel(item.platform) : fallback;
}

function requireText(params: Record<string, unknown>): string {
  if (!nonEmpty(params.text)) throw new Error("text is empty, so there is nothing to send. Nothing was sent.");
  return params.text;
}

async function requireInboxReply(cfg: PluginConfig, action: string): Promise<void> {
  const me = await keyCapabilities(cfg, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
  if (me && Array.isArray(me.permissions) && !me.permissions.includes("inbox.reply")) {
    throw new Error(
      `${roleHolder(me)} cannot ${action}: every inbox write needs inbox.reply, which only the Editor and Admin roles hold, so AdaptlyPost would refuse with 403 permission_denied. Nothing was sent or changed. Tell the user a workspace member with an Editor or Admin role has to do it in the AdaptlyPost app, or give the agent a key with that role.`,
    );
  }
}

async function lookupInboxItem<T>(what: string, id: string, load: (signal: AbortSignal) => Promise<T | undefined>): Promise<Lookup<T>> {
  const note = `Could not load ${what} ${id} for this prompt, so it is named by id only.`;
  try {
    const item = await load(AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
    return item ? { item } : { note };
  } catch (error) {
    if (error instanceof AdaptlyPostApiError && error.status === 404) {
      throw new Error(`There is no ${what} with id ${id} in this workspace's inbox, so nothing was sent or changed. List the inbox again for current ids.`);
    }
    return { note };
  }
}

async function findInRecentList<T extends { id: string }>(
  cfg: PluginConfig,
  path: string,
  key: string,
  id: string,
  signal: AbortSignal,
): Promise<T | undefined> {
  const page = (await callApi(cfg, "GET", path, { query: { limit: INBOX_LIST_LOOKUP_LIMIT }, signal })) as Record<string, unknown>;
  const items = Array.isArray(page[key]) ? (page[key] as T[]) : [];
  return items.find((item) => item.id === id);
}

function requireCapability(item: InboxItemBase | undefined, capability: keyof InboxCapabilities, what: string): void {
  if (item?.capabilities?.[capability] === false) {
    throw new Error(
      `${platformLabel(item.platform)} does not allow this on ${what} ${item.id} (capabilities.${capability} is false), so AdaptlyPost would refuse with 400 inbox_action_unsupported. Nothing was sent or changed.`,
    );
  }
}

function inboxPrompt(
  title: string,
  before: string[],
  quote: { label: string; text?: string | null } | undefined,
  after: string[],
  ifTooLong: string,
): string {
  const fixed = [...before, ...after];
  let lines = fixed;
  if (quote && nonEmpty(quote.text)) {
    const room = DESCRIPTION_LIMIT - fixed.join("\n").length - quote.label.length - 5;
    const limit = Math.min(INBOX_QUOTE_LIMIT, room);
    if (limit >= INBOX_MIN_QUOTE) lines = [...before, `${quote.label}: "${shorten(quote.text, limit)}"`, ...after];
  }
  return requireFullPrompt(title, lines, ifTooLong);
}

const SHORTEN_TEXT = "Shorten the text, or let the user send it from the AdaptlyPost app.";

type CommentAction = {
  title: string;
  effect: string;
  action: string;
  capability: keyof InboxCapabilities;
  withText: boolean;
  severity: ApprovalRequest["severity"];
  visibility: ApprovalRequest["scope"]["visibility"];
};

const COMMENT_ACTIONS: Record<string, CommentAction> = {
  [REPLY_INBOX_COMMENT_TOOL]: {
    title: "Reply to a comment",
    effect: "Posts this reply publicly under the comment, from the account below. It goes out immediately.",
    action: "reply to comments",
    capability: "canReply",
    withText: true,
    severity: "critical",
    visibility: "public",
  },
  [HIDE_INBOX_COMMENT_TOOL]: {
    title: "Hide a comment",
    effect: "Hides the comment on the platform. Its author may still see it.",
    action: "hide comments",
    capability: "canHide",
    withText: false,
    severity: "warning",
    visibility: "restricted",
  },
  [UNHIDE_INBOX_COMMENT_TOOL]: {
    title: "Unhide a comment",
    effect: "Makes the hidden comment visible to everyone again.",
    action: "unhide comments",
    capability: "canHide",
    withText: false,
    severity: "warning",
    visibility: "public",
  },
  [DELETE_INBOX_COMMENT_TOOL]: {
    title: "Delete a comment",
    effect: "Deletes the comment on the platform and in AdaptlyPost. This cannot be undone.",
    action: "delete comments",
    capability: "canDelete",
    withText: false,
    severity: "critical",
    visibility: "restricted",
  },
};

async function describeCommentAction(
  cfg: PluginConfig,
  toolName: string,
  params: Record<string, unknown>,
): Promise<ApprovalRequest> {
  const change = COMMENT_ACTIONS[toolName];
  const commentId = String(params.comment_id ?? "");
  const text = change.withText ? requireText(params) : undefined;
  const [, { item, note }] = await Promise.all([
    requireInboxReply(cfg, change.action),
    lookupInboxItem("comment", commentId, async (signal) => {
      const found = (await callApi(cfg, "GET", `/inbox/comments/${encodeURIComponent(commentId)}`, { signal })) as {
        comment?: InboxCommentRecord;
      };
      return found.comment;
    }),
  ]);
  requireCapability(item, change.capability, "comment");

  const before = [change.effect, ...[inboxAccountLine(item), note].filter(nonEmpty)];
  const quote = item ? { label: `Comment by ${personLabel(item.author)}`, text: item.text } : undefined;
  const after = text ? [`Reply: "${text}"`] : [];
  return {
    title: change.title,
    description: inboxPrompt(change.title, before, quote, after, SHORTEN_TEXT),
    severity: change.severity,
    scope: { kind: "external-post", target: inboxTarget(item, commentId), visibility: change.visibility },
  };
}

async function describeMentionReply(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest> {
  const mentionId = String(params.mention_id ?? "");
  const text = requireText(params);
  const [, { item, note }] = await Promise.all([
    requireInboxReply(cfg, "reply to mentions"),
    lookupInboxItem("mention", mentionId, (signal) =>
      findInRecentList<InboxMentionRecord>(cfg, "/inbox/mentions", "mentions", mentionId, signal),
    ),
  ]);
  requireCapability(item, "canReply", "mention");

  const title = "Reply to a mention";
  const before = [
    "Posts this reply publicly to the post that mentioned the account, from the account below. It goes out immediately.",
    ...[inboxAccountLine(item), note].filter(nonEmpty),
  ];
  const quote = item ? { label: `Mention by ${personLabel(item.author)}`, text: item.text } : undefined;
  return {
    title,
    description: inboxPrompt(title, before, quote, [`Reply: "${text}"`], SHORTEN_TEXT),
    severity: "critical",
    scope: { kind: "external-post", target: inboxTarget(item, mentionId), visibility: "public" },
  };
}

async function describeMessage(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest> {
  const conversationId = String(params.conversation_id ?? "");
  const text = requireText(params);
  const [, { item, note }] = await Promise.all([
    requireInboxReply(cfg, "send direct messages"),
    lookupInboxItem("conversation", conversationId, async (signal) =>
      (await callApi(cfg, "GET", `/inbox/conversations/${encodeURIComponent(conversationId)}`, { signal })) as {
        conversation?: InboxConversationRecord;
        messages?: InboxMessageRecord[];
      },
    ),
  ]);
  const conversation = item?.conversation;
  requireCapability(conversation, "canReply", "conversation");
  if (conversation?.replyWindowEndsAt && Date.parse(conversation.replyWindowEndsAt) <= Date.now()) {
    throw new Error(
      `The 24-hour reply window of this ${platformLabel(conversation.platform)} conversation closed at ${conversation.replyWindowEndsAt}, so AdaptlyPost would refuse with 400 inbox_messaging_window_closed. Nothing was sent. Tell the user.`,
    );
  }

  const lastInbound = [...(item?.messages ?? [])].reverse().find((message) => !message.isOwn);
  const title = "Send a direct message";
  const before = [
    `Sends this message privately to ${conversation ? personLabel(conversation.participant) : `conversation ${conversationId}`}, from the account below. It goes out immediately.`,
    ...[inboxAccountLine(conversation), note].filter(nonEmpty),
    ...(conversation?.replyWindowEndsAt ? [`Reply window ends ${conversation.replyWindowEndsAt}.`] : []),
  ];
  const quote = lastInbound
    ? { label: "Their last message", text: nonEmpty(lastInbound.text) ? lastInbound.text : lastInbound.hasAttachments ? "(attachment)" : "" }
    : undefined;
  return {
    title,
    description: inboxPrompt(title, before, quote, [`Message: "${text}"`], SHORTEN_TEXT),
    severity: "critical",
    scope: { kind: "external-post", target: inboxTarget(conversation, conversationId), visibility: "restricted" },
  };
}

async function describeReviewAction(
  cfg: PluginConfig,
  toolName: string,
  params: Record<string, unknown>,
): Promise<ApprovalRequest> {
  const deleting = toolName === DELETE_INBOX_REVIEW_REPLY_TOOL;
  const reviewId = String(params.review_id ?? "");
  const text = deleting ? undefined : requireText(params);
  const [, { item, note }] = await Promise.all([
    requireInboxReply(cfg, deleting ? "delete review replies" : "reply to reviews"),
    lookupInboxItem("review", reviewId, (signal) =>
      findInRecentList<InboxReviewRecord>(cfg, "/inbox/reviews", "reviews", reviewId, signal),
    ),
  ]);
  if (!deleting) requireCapability(item, "canReply", "review");
  const currentReply = item?.reply && nonEmpty(item.reply.text) ? item.reply.text : undefined;
  if (deleting && item && !item.reply) {
    throw new Error(`Review ${reviewId} has no reply to delete, so nothing was changed.`);
  }

  const title = deleting ? "Delete a Google review reply" : "Reply to a Google review";
  const effect = deleting
    ? "Deletes the business's public reply to this review on Google. The review stays."
    : currentReply
      ? "Replaces the business's public reply to this review on Google."
      : "Posts this public reply to the review on Google, as the business.";
  const before = [effect, ...[inboxAccountLine(item), note].filter(nonEmpty)];
  const stars = typeof item?.rating === "number" ? `${item.rating}-star review` : "Review";
  const quote = item
    ? { label: `${stars} by ${personLabel(item.reviewer)}`, text: nonEmpty(item.text) ? item.text : "(rating only, no text)" }
    : undefined;
  const after = deleting
    ? currentReply
      ? [`Reply being deleted: "${shorten(currentReply, INBOX_QUOTE_LIMIT)}"`]
      : []
    : [...(currentReply ? [`Current reply: "${shorten(currentReply, 80)}"`] : []), `New reply: "${text}"`];
  return {
    title,
    description: inboxPrompt(title, before, quote, after, SHORTEN_TEXT),
    severity: deleting ? "warning" : "critical",
    scope: { kind: "external-post", target: inboxTarget(item, reviewId), visibility: deleting ? "restricted" : "public" },
  };
}

export async function describeApproval(
  cfg: PluginConfig,
  toolName: string,
  params: Record<string, unknown>,
): Promise<ApprovalRequest | undefined> {
  switch (toolName) {
    case UPLOAD_TOOL:
      return describeUpload(cfg, params);
    case CREATE_POST_TOOL:
      return describePost(cfg, params);
    case RETRY_TOOL:
      return describeRetry(cfg, params);
    case UNSCHEDULE_TOOL:
      return describeUnschedule(cfg, params);
    case PAUSE_RECURRING_TOOL:
    case RESUME_RECURRING_TOOL:
    case DELETE_RECURRING_TOOL:
      return describeSeriesChange(cfg, toolName, params);
    case REMOVE_ACCOUNT_TOOL:
      return describeAccountRemoval(cfg, params);
    case REPLY_INBOX_COMMENT_TOOL:
    case HIDE_INBOX_COMMENT_TOOL:
    case UNHIDE_INBOX_COMMENT_TOOL:
    case DELETE_INBOX_COMMENT_TOOL:
      return describeCommentAction(cfg, toolName, params);
    case REPLY_INBOX_MENTION_TOOL:
      return describeMentionReply(cfg, params);
    case SEND_INBOX_MESSAGE_TOOL:
      return describeMessage(cfg, params);
    case REPLY_INBOX_REVIEW_TOOL:
    case DELETE_INBOX_REVIEW_REPLY_TOOL:
      return describeReviewAction(cfg, toolName, params);
    default:
      return undefined;
  }
}
