import { createHash } from "node:crypto";
import {
  callApi,
  describeLocalMedia,
  describeRemoteUrl,
  keyCapabilities,
  parseRemoteUrl,
  resolveLocalMedia,
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
export const GATED_TOOLS = [
  UPLOAD_TOOL,
  CREATE_POST_TOOL,
  RETRY_TOOL,
  UNSCHEDULE_TOOL,
  PAUSE_RECURRING_TOOL,
  RESUME_RECURRING_TOOL,
  DELETE_RECURRING_TOOL,
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
};

type Account = { id: string; platform: string; displayName?: string; username?: string; pageId?: string };

function lookupFailed(what: string, error: unknown): Error {
  return new Error(
    `Could not load ${what} for the approval prompt, so nothing was uploaded or published: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function fetchAccountNames(cfg: PluginConfig): Promise<Map<string, string>> {
  const { accounts = [] } = (await callApi(cfg, "GET", "/social-accounts", {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw lookupFailed("the connected accounts", error);
  })) as { accounts?: Account[] };
  const names = new Map<string, string>();
  for (const account of accounts) {
    const name = account.username ? `@${account.username}` : (account.displayName ?? account.id);
    names.set(account.id, name);
    if (account.pageId) names.set(account.pageId, name);
  }
  return names;
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
      if (scheduledAt !== undefined) {
        throw new Error("mode DRAFT cannot carry scheduledAt. Drop scheduledAt, or use mode SCHEDULE.");
      }
      return { ...rest, saveAsDraft: true };
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

function settingLines(params: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const entry of configEntries(params, "tiktokConfigs")) {
    lines.push(
      `TikTok: ${String(entry.privacyLevel)}${entry.sendAsDraft ? ", sent to TikTok drafts" : ""}${nonEmpty(entry.title) ? `, title "${entry.title}"` : ""}`,
    );
  }
  for (const entry of configEntries(params, "youtubeConfigs")) {
    lines.push(
      `YouTube: ${String(entry.privacyStatus ?? "public")} ${String(entry.postType ?? "VIDEO")}${entry.madeForKids ? ", made for kids" : ""}${nonEmpty(entry.videoTitle) ? `, title "${entry.videoTitle}"` : ""}`,
    );
  }
  for (const entry of configEntries(params, "instagramConfigs")) {
    lines.push(`Instagram: ${String(entry.postType ?? "FEED")}`);
  }
  for (const entry of configEntries(params, "facebookConfigs")) {
    lines.push(
      `Facebook: ${String(entry.postType ?? "FEED")}${nonEmpty(entry.videoTitle) ? `, title "${entry.videoTitle}"` : ""}`,
    );
  }
  for (const entry of configEntries(params, "linkedinConfigs")) {
    if (nonEmpty(entry.documentTitle)) lines.push(`LinkedIn: document title "${entry.documentTitle}"`);
  }
  for (const entry of configEntries(params, "pinterestConfigs")) {
    lines.push(
      `Pinterest: board ${String(entry.boardId)}${nonEmpty(entry.title) ? `, title "${entry.title}"` : ""}${nonEmpty(entry.link) ? `, link ${entry.link}` : ""}`,
    );
  }
  return lines;
}

function fileName(url: string): string {
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
  const [names, me] = await Promise.all([
    fetchAccountNames(cfg),
    keyCapabilities(cfg, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)),
  ]);
  const targets = platforms.flatMap((platform) =>
    stringArray(params[CONNECTION_FIELDS[platform] ?? ""]).map((id) => {
      const name = names.get(id);
      if (!name) {
        throw new Error(
          `Account ${id} for ${PLATFORM_LABELS[platform] ?? platform} is not among the connected accounts, so the approval prompt cannot name it. Nothing was published. Take ids from adaptlypost_accounts.`,
        );
      }
      return `${PLATFORM_LABELS[platform] ?? platform} ${name}`;
    }),
  );
  if (!targets.length) throw new Error("No connection ids were given for the selected platforms. Nothing was published.");

  const publishNow = params.mode === "PUBLISH_NOW";
  const refused = refusedAction(me, publishNow);
  const recurrence = recurrenceOf(params);
  if (refused && recurrence && me) {
    throw new Error(
      `This key has the ${me.role.name} role, which cannot schedule, and a recurring post cannot be saved as a draft, so nothing was created. Save a single post with mode DRAFT instead, or ask a workspace member with an Editor or Admin role to set up the repeat in the AdaptlyPost app.`,
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
      ? `AdaptlyPost will refuse to ${refused}: this key has the ${me.role.name} role. Approve to save the post below as a draft for a workspace member to ${refused}; deny to do nothing.`
      : timing,
    ...(recurrence ? [describeRecurrence(withFirstWeekday(recurrence, String(body.scheduledAt), nonEmpty(params.timezone) ? params.timezone : "UTC"))] : []),
    `Accounts: ${targets.join(", ")}`,
    ...settingLines(params),
    ...(media.length ? [`Media: ${media.join(", ")}`] : []),
    ...(altTextCount ? [`Alt text on ${altTextCount} of ${media.length} images`] : []),
    ...(nonEmpty(params.thumbnailUrl) ? [`Thumbnail: ${fileName(params.thumbnailUrl)}`] : []),
    ...textLines(params),
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
    nonEmpty(entry.pinterestBoardId) ? `board ${entry.pinterestBoardId}` : undefined,
  ].filter(nonEmpty);
  const titles = [entry.tiktokTitle, entry.youtubeVideoTitle, entry.facebookVideoTitle, entry.pinterestTitle].filter(
    nonEmpty,
  );
  const media = stringArray(entry.mediaUrls).map(fileName);
  const text = nonEmpty(entry.text) ? entry.text : fallbackText;
  return [
    `${label} ${String(entry.accountName ?? entry.id)}${settings.length ? ` (${settings.join(", ")})` : ""}`,
    ...titles.map((title) => `  Title: "${title}"`),
    ...(nonEmpty(entry.pinterestLink) ? [`  Link: ${entry.pinterestLink}`] : []),
    ...(media.length ? [`  Media: ${media.join(", ")}`] : []),
    `  Text: ${nonEmpty(text) ? `"${text}"` : "(none)"}`,
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
      `This key has the ${me.role.name} role, which cannot publish, so AdaptlyPost would refuse the retry with 403 permission_denied. Nothing was retried. Tell the user a workspace member with an Editor or Admin role has to retry it in the AdaptlyPost app, or give the agent a key with that role.`,
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
  const post = (await callApi(cfg, "GET", `/social-posts/${encodeURIComponent(postId)}`, {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw lookupFailed(`post ${postId}`, error);
  })) as PostRecord & { scheduledAt?: string | null };

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
      `This key has the ${me.role.name} role, which cannot ${change.verb.toLowerCase()} recurring posts, so AdaptlyPost would refuse with 403 permission_denied. Nothing was changed. Tell the user a workspace member with an Editor or Admin role has to do it in the AdaptlyPost app, or give the agent a key with that role.`,
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
    default:
      return undefined;
  }
}
