import { createHash } from "node:crypto";
import {
  callApi,
  describeLocalMedia,
  describeRemoteUrl,
  parseRemoteUrl,
  resolveLocalMedia,
  type PluginConfig,
} from "./api.js";

export const UPLOAD_TOOL = "adaptlypost_upload_media";
export const CREATE_POST_TOOL = "adaptlypost_create_post";
export const RETRY_TOOL = "adaptlypost_retry_failed";
export const GATED_TOOLS = [UPLOAD_TOOL, CREATE_POST_TOOL, RETRY_TOOL] as const;

export const APPROVAL_TIMEOUT_MS = 300_000;
const GRANT_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const DESCRIPTION_LIMIT = 512;

export type PostMode = "DRAFT" | "SCHEDULE" | "PUBLISH_NOW";

export type ApprovalRequest = {
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
  scope: { kind: "external-post"; target: string; visibility: "public" | "restricted" };
};

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
  private readonly grants = new Map<string, { digest: string; expiresAt: number }>();

  grant(toolCallId: string, params: unknown): void {
    this.grants.set(toolCallId, { digest: digest(params), expiresAt: Date.now() + GRANT_TTL_MS });
  }

  consume(toolCallId: string, toolName: string, params: unknown): void {
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

export function buildPostBody(params: Record<string, unknown>): Record<string, unknown> {
  const { mode, scheduledAt, ...rest } = params as { mode?: PostMode; scheduledAt?: unknown } & Record<
    string,
    unknown
  >;

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

async function describePost(cfg: PluginConfig, params: Record<string, unknown>): Promise<ApprovalRequest | undefined> {
  const body = buildPostBody(params);
  if (params.mode === "DRAFT") return undefined;

  const platforms = stringArray(params.platforms);
  const names = await fetchAccountNames(cfg);
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
  const title = `${publishNow ? "Publish now" : "Schedule a post"} to ${targets.length} account${targets.length === 1 ? "" : "s"}`;
  const media = stringArray(params.mediaUrls).map(fileName);
  const lines = [
    publishNow
      ? "Publishes immediately and cannot be recalled."
      : `Scheduled for ${String(body.scheduledAt)}${nonEmpty(params.timezone) ? ` (${params.timezone})` : ""}.`,
    `Accounts: ${targets.join(", ")}`,
    ...settingLines(params),
    ...(media.length ? [`Media: ${media.join(", ")}`] : []),
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
    severity: publishNow ? "critical" : "warning",
    scope: {
      kind: "external-post",
      target: platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(", "),
      visibility: "public",
    },
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
  const [post, results] = await Promise.all([
    callApi(cfg, "GET", path, { signal }) as Promise<PostRecord>,
    callApi(cfg, "GET", `${path}/results`, { signal }) as Promise<{ results?: ResultRow[] }>,
  ]).catch((error: unknown) => {
    throw lookupFailed(`post ${postId}`, error);
  });

  const failedIds = new Set(
    (results.results ?? [])
      .filter((row) => platformIds.includes(row.platformId) && row.status === "FAILED")
      .map((row) => row.platformId),
  );
  const entries = (post.platforms ?? []).filter((entry) => failedIds.has(entry.id));
  if (!entries.length || entries.length !== failedIds.size) {
    throw new Error("None of platform_ids is a FAILED platform of this post that can be shown for approval. Nothing was retried.");
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
    default:
      return undefined;
  }
}
