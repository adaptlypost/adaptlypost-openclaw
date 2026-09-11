import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { extname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export const API_BASE_URL = "https://post.adaptlypost.com/post/api/v1";
const TOKEN_PREFIX = "adaptly_";

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * MB;
const MAX_VIDEO_BYTES = 1024 * MB;
const MAX_REMOTE_BYTES = 250 * MB;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type PluginConfig = { apiToken?: string; mediaDirs?: string[] };

export function readConfig(api: { config?: unknown }): PluginConfig {
  const root = api.config as
    | { plugins?: { entries?: Record<string, { config?: PluginConfig }> } }
    | undefined;
  return root?.plugins?.entries?.["adaptlypost"]?.config ?? {};
}

function requireToken(cfg: PluginConfig): string {
  if (!cfg.apiToken) {
    throw new Error(
      "No AdaptlyPost API token configured. Set plugins.entries.adaptlypost.config.apiToken. Create a token at https://adaptlypost.com under Settings then API Tokens.",
    );
  }
  if (!cfg.apiToken.startsWith(TOKEN_PREFIX)) {
    throw new Error(
      `AdaptlyPost API tokens start with "${TOKEN_PREFIX}". The configured value does not, so the API will reject it.`,
    );
  }
  return cfg.apiToken;
}

function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export async function callApi(
  cfg: PluginConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; query?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<unknown> {
  const token = requireToken(cfg);
  const url = `${API_BASE_URL}${path}${options.query ? buildQuery(options.query) : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: "error",
    signal: options.signal,
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw new Error(
        `AdaptlyPost rate limit reached (600 requests per minute per token).${retryAfter ? ` Retry after ${retryAfter}s.` : ""} Wait rather than retrying immediately.`,
      );
    }
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === "string"
          ? parsed
          : JSON.stringify(parsed);
    throw new Error(`AdaptlyPost API ${res.status}: ${message}`);
  }

  return parsed;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

export const SUPPORTED_MIME_TYPES = Object.keys(EXT_BY_MIME);

const QUICKTIME_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const box = ascii(bytes, 4, 8);
  if (box === "ftyp") return ascii(bytes, 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  if (QUICKTIME_ATOMS.has(box)) return "video/quicktime";
  return undefined;
}

function requireMediaContent(bytes: Uint8Array, source: string): string {
  const mimeType = sniffMimeType(bytes);
  if (!mimeType) {
    throw new Error(
      `${source} is not a JPEG, PNG, WebP, MP4 or QuickTime file. Its content was checked, not just its name.`,
    );
  }
  return mimeType;
}

function formatBytes(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type UploadedMedia = { publicUrl: string; key: string };

async function uploadBuffer(
  cfg: PluginConfig,
  body: Uint8Array<ArrayBuffer>,
  fileName: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<UploadedMedia> {
  const minted = (await callApi(cfg, "POST", "/upload-urls", {
    body: { files: [{ fileName, mimeType }] },
    signal,
  })) as { urls?: { uploadUrl: string; publicUrl: string; key: string }[] };

  const target = minted.urls?.[0];
  if (!target) throw new Error("AdaptlyPost did not return an upload URL.");
  if (new URL(target.uploadUrl).protocol !== "https:") {
    throw new Error("AdaptlyPost returned a non-HTTPS upload URL, so the upload was not attempted.");
  }

  const put = await fetch(target.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: new Blob([body], { type: mimeType }),
    redirect: "error",
    signal,
  });
  if (!put.ok) {
    throw new Error(
      `Upload to storage failed (${put.status}). The media is not stored, so create_post would reject it.`,
    );
  }

  return { publicUrl: target.publicUrl, key: target.key };
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function resolveMediaRoots(cfg: PluginConfig): Promise<string[]> {
  const configured = cfg.mediaDirs ?? [];
  if (!configured.length) {
    throw new Error(
      "Local file uploads are off. Add the folders the agent may upload from to plugins.entries.adaptlypost.config.mediaDirs, or pass a public URL instead.",
    );
  }
  const home = await realpath(homedir()).catch(() => homedir());
  return Promise.all(
    configured.map(async (dir) => {
      const root = await realpath(resolve(expandHome(dir))).catch(() => {
        throw new Error(`Configured media folder does not exist: ${dir}`);
      });
      if (root === parse(root).root || root === home) {
        throw new Error(
          `mediaDirs entry "${dir}" is the filesystem root or the home folder. Point it at a dedicated media folder.`,
        );
      }
      return root;
    }),
  );
}

export type LocalMediaFile = { path: string; size: number };

export async function resolveLocalMedia(cfg: PluginConfig, filePath: string): Promise<LocalMediaFile> {
  const roots = await resolveMediaRoots(cfg);
  const expanded = expandHome(filePath);
  const requested = isAbsolute(expanded) ? resolve(expanded) : resolve(roots[0], expanded);

  const declaredMime = MIME_BY_EXT[extname(requested).toLowerCase()];
  if (!declaredMime) {
    throw new Error(
      `Unsupported media type for "${filePath}". AdaptlyPost accepts .jpg, .jpeg, .png, .webp, .mp4 and .mov files.`,
    );
  }

  const real = await realpath(requested).catch(() => null);
  if (!real) throw new Error(`File not found: ${requested}`);

  const root = roots.find((candidate) => isInside(candidate, real));
  if (!root) {
    throw new Error(
      `${real} is outside the configured media folders (${roots.join(", ")}). Only files inside mediaDirs can be uploaded.`,
    );
  }
  if (relative(root, real).split(sep).some((segment) => segment.startsWith("."))) {
    throw new Error(`${real} is hidden or inside a hidden folder, so it will not be uploaded.`);
  }
  if (MIME_BY_EXT[extname(real).toLowerCase()] === undefined) {
    throw new Error(`${filePath} resolves to ${real}, which is not a supported media file.`);
  }

  const info = await stat(real);
  if (!info.isFile()) throw new Error(`Not a regular file: ${real}`);
  const limit = declaredMime.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (info.size > limit) {
    throw new Error(`${real} is ${formatBytes(info.size)}, over the ${formatBytes(limit)} upload limit.`);
  }
  return { path: real, size: info.size };
}

export function describeLocalMedia(file: LocalMediaFile): string {
  return `${file.path} (${formatBytes(file.size)})`;
}

export async function uploadLocalFile(
  cfg: PluginConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<UploadedMedia> {
  const file = await resolveLocalMedia(cfg, filePath);
  const body = await readFile(file.path);
  const mimeType = requireMediaContent(body, file.path);
  const { name } = parse(file.path);
  return uploadBuffer(cfg, body, `${name}${EXT_BY_MIME[mimeType]}`, mimeType, signal);
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export function parseRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error(`Only https:// media URLs are accepted: ${raw}`);
  if (url.username || url.password) throw new Error("Media URLs must not carry credentials.");
  if (url.port && url.port !== "443") throw new Error(`Media URLs must use the standard HTTPS port: ${raw}`);

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`Media URLs must point at a public host, not ${host}.`);
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new Error(`Media URLs must point at a public address, not ${host}.`);
  }
  return url;
}

export function describeRemoteUrl(url: URL): string {
  return `${url.hostname}${url.pathname}`;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    if (blocked || !addresses.length) {
      return callback(
        Object.assign(new Error(`${hostname} resolves to a private or reserved address, so it was not fetched.`), {
          code: "EADDRNOTAVAIL",
        }),
        "",
      );
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function httpsGet(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      url,
      { method: "GET", lookup: publicOnlyLookup, signal, headers: { Accept: "image/*,video/*" } },
      resolveResponse,
    );
    req.on("error", reject);
    req.end();
  });
}

async function readBounded(res: IncomingMessage, source: string): Promise<Buffer<ArrayBuffer>> {
  const declared = Number(res.headers["content-length"]);
  if (declared > MAX_REMOTE_BYTES) {
    res.destroy();
    throw new Error(`${source} is ${formatBytes(declared)}, over the ${formatBytes(MAX_REMOTE_BYTES)} URL download limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_REMOTE_BYTES) {
      res.destroy();
      throw new Error(`${source} is over the ${formatBytes(MAX_REMOTE_BYTES)} URL download limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadPublicMedia(sourceUrl: string, signal?: AbortSignal): Promise<{ body: Buffer<ArrayBuffer>; url: URL }> {
  const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = parseRemoteUrl(sourceUrl);

  for (let redirects = 0; ; redirects++) {
    const res = await httpsGet(url, combined);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (status >= 300 && status < 400 && location) {
      res.resume();
      if (redirects >= MAX_REDIRECTS) throw new Error(`${describeRemoteUrl(url)} redirected too many times.`);
      url = parseRemoteUrl(new URL(location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`Failed to download ${describeRemoteUrl(url)}: HTTP ${status}`);
    }
    return { body: await readBounded(res, describeRemoteUrl(url)), url };
  }
}

function fileStemFromUrl(url: URL): string {
  const lastSegment = url.pathname.split("/").pop() ?? "";
  const stem = parse(lastSegment).name.replace(/[^\w.-]+/g, "-").slice(0, 80);
  return stem || "upload";
}

export async function uploadRemoteUrl(
  cfg: PluginConfig,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<UploadedMedia> {
  const { body, url } = await downloadPublicMedia(sourceUrl, signal);
  const mimeType = requireMediaContent(body, describeRemoteUrl(url));
  if (mimeType.startsWith("image/") && body.length > MAX_IMAGE_BYTES) {
    throw new Error(`${describeRemoteUrl(url)} is over the ${formatBytes(MAX_IMAGE_BYTES)} image limit.`);
  }
  return uploadBuffer(cfg, body, `${fileStemFromUrl(url)}${EXT_BY_MIME[mimeType]}`, mimeType, signal);
}
