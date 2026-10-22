# AdaptlyPost plugin for OpenClaw

Schedule and publish social posts to LinkedIn, X, Instagram, Facebook, TikTok,
YouTube, Pinterest, Threads, Bluesky, Mastodon and Google Business Profile, from
inside OpenClaw.

## Install

```bash
openclaw plugins install clawhub:@adaptlypost/openclaw-plugin
openclaw plugins enable adaptlypost
openclaw gateway restart
```

Create a dedicated, revocable token at
[adaptlypost.com](https://adaptlypost.com) under Settings, then API Tokens. Do
not reuse a token that other tools or people also hold.

```json5
{
  plugins: {
    entries: {
      adaptlypost: {
        enabled: true,
        config: {
          apiToken: "adaptly_...",
          mediaDirs: ["~/Pictures/social"]
        }
      }
    }
  }
}
```

The token decides the account group, so you never pass an account id. Connect
only the accounts the agent actually needs, since the token reaches every
account in the group.

The token also carries a role, chosen when you create it, and never does more
than you can. A Contributor token lets the agent draft and upload but not
schedule, publish or retry; give it an Editor token only when the agent itself
must publish. The plugin reads `GET /me` once per token before it asks you to
approve a scheduled or live post. When the token cannot do what the agent asked,
the prompt says so up front and approving saves the post as a draft instead, for
you to publish in the AdaptlyPost app. A retry with such a token is refused
before it reaches you. When AdaptlyPost itself answers `403 permission_denied`,
the agent sees the server's message, the missing permission and the token's
role, and is told to stop rather than retry. When the member who created the
token has since been demoted below the token's role, both roles are named,
because the token holds only that member's permissions.

`mediaDirs` lists the folders the agent may upload local files from. Leave it
out and only URL uploads work. Don't point it at your home folder; the plugin
refuses that, and the filesystem root too.

## Approvals

Four actions put something in public, so each one stops for your approval
before it runs:

- uploading media, since a stored file gets a public URL right away
- scheduling a post, including a recurring one, where the prompt also says how
  it repeats (for example "Repeats weekly on Mon, Fri until 2026-12-31.")
- publishing a post now
- retrying failed platforms, which republishes immediately

Unscheduling a post and pausing, resuming or deleting a recurring post also stop
for approval. The prompt names the series, its schedule, its accounts and its
text. A token whose role cannot change a scheduled series, or cannot unschedule
a scheduled post (Contributor and Viewer), is refused before the prompt.

The prompt shows everything that will go public: each file with its full path
or URL, each account by name, the timing, each platform's visibility and title,
and every caption including per-platform overrides. It also lists each first
comment, Instagram collaborators, audio and story sharing, Facebook story
sharing and text backgrounds, the Google Business Profile topic, event, offer
and button, per-platform thumbnails and image shapes, and X links that stay
clickable. OpenClaw caps a prompt at
512 characters. When a call doesn't fit, the plugin refuses it instead of
cutting anything, and tells the agent to save a draft or split the call. The
prompt offers "allow once" and "deny", never "always". The plugin ties each approval
to one tool call and a hash of its exact arguments, so a changed or replayed
call is refused. Saving a draft, or checking a post with
`adaptlypost_validate_post`, needs no approval.

When nobody can answer (a cron run, or a channel without approval support),
OpenClaw denies the call. Unattended agents can still save drafts. To get the
prompts in a chat channel, set `approvals.plugin` in your OpenClaw config; see
OpenClaw's plugin permission requests docs.

## What the plugin refuses

- A scheduled or live post to an account whose status is `unauthorized` is
  refused before the prompt, because AdaptlyPost would refuse it with 400. The
  agent is told to have you reconnect the account or leave it out.
- API calls go only to `https://post.adaptlypost.com/post/api/v1`. The base URL
  is fixed in code and redirects are not followed, so the token cannot be sent
  anywhere else.
- Local uploads must resolve, symlinks included, to a file inside `mediaDirs`.
  Hidden files and folders are skipped, and a file must really be a JPEG, PNG,
  WebP, MP4 or QuickTime file. The plugin checks its first bytes, not just the
  name. The size limit is 50 MB per image and 1 GB per video.
- URL uploads must be `https://` on port 443 without credentials. The plugin
  checks the addresses each connection actually uses, including after each of
  up to three redirects, against the loopback, private, link-local, CGNAT,
  multicast and reserved ranges, so DNS rebinding cannot slip past it. Downloads stop at
  250 MB or two minutes.

## Tools

| tool | what it does |
|---|---|
| `adaptlypost_accounts` | List connected accounts and their connection ids, with `status` (`active` or `unauthorized`). Call this first. |
| `adaptlypost_check_account` | Ask Facebook right now whether a page's token still works and return its fresh status. Use after the user reconnects a page. |
| `adaptlypost_remove_account` | Disconnect an account from the workspace, unauthorized ones included. Admin keys only. Needs approval. |
| `adaptlypost_search_instagram_audio` | Search Instagram music and original sounds, or list trending audio, for a Reel. |
| `adaptlypost_list_pinterest_boards` | List the boards a Pinterest account can pin to, secret boards included. |
| `adaptlypost_upload_media` | Upload files from `mediaDirs` or public URLs, returns public media URLs. Needs approval. |
| `adaptlypost_create_post` | Draft, schedule, or publish one post across any set of accounts. `mode` is required; SCHEDULE and PUBLISH_NOW need approval. |
| `adaptlypost_validate_post` | Check a post without creating it. Takes the same parameters as `adaptlypost_create_post` and returns each account's status, the issues to fix and what only the platform can decide. Needs no approval. |
| `adaptlypost_list_posts` | List posts, including scheduled and draft. |
| `adaptlypost_post_results` | Read the per-platform result for one post. |
| `adaptlypost_retry_failed` | Retry only the platforms that failed. Needs approval. |
| `adaptlypost_unschedule_post` | Take a scheduled post off the calendar and keep it as an undated draft. Needs approval. |
| `adaptlypost_list_recurring_posts` | List recurring posts, filtered by `ACTIVE`, `PAUSED` or `ENDED`. |
| `adaptlypost_get_recurring_post` | Read one recurring post, including why it paused. |
| `adaptlypost_pause_recurring_post` | Stop a series and delete its upcoming scheduled post. Needs approval. |
| `adaptlypost_resume_recurring_post` | Restart a paused series from the next date after now. Needs approval. |
| `adaptlypost_delete_recurring_post` | Delete a series for good. Published posts stay. Needs approval. |
| `adaptlypost_analytics_overview` | Views, likes, comments, shares, followers and engagement for a date window, against the previous window. |
| `adaptlypost_post_analytics` | Per-post metrics, sortable by any metric; top posts and "how did this post do". |

Nineteen tools, fewer than the MCP server exposes. Post editing, deletion,
draft publishing, bulk scheduling and the finer analytics cuts (timeseries,
per-platform breakdown, sync control) stay out, because an agent picking from
a long list of near-identical tools picks worse. Those live in the
[MCP server](https://github.com/TarasShyn/adaptlypost-mcp) and the REST API.

## Things worth knowing

Connection ids are per platform and go in the matching array, so a LinkedIn id
belongs in `linkedinConnectionIds`. Facebook is the exception: pages have no
username, so they carry a `pageId` and go in `pageIds`.

TikTok needs `privacyLevel` in `tiktokConfigs` and has no default; the post is
rejected outright without it. For Pinterest, pass the board the user named as
`boardName` in `pinterestConfigs`; AdaptlyPost finds it among that account's
boards and answers 400 when no board or several boards have that name. Or find
a board with `adaptlypost_list_pinterest_boards` and pass its `id` as
`boardId`. Send one or the other, not both. A board belongs to one Pinterest
account. With neither, the pin goes to a public board named "AdaptlyPost",
created on the account the first time it is needed, and the approval prompt
says so.

Google Business Profile locations go in `googleBusinessConnectionIds`. A post
there is text, or text with one JPEG or PNG image up to 5 MB, up to 1500
characters. Without a `googleBusinessConfigs` entry it goes out as a plain
update; set `topicType` to `EVENT` or `OFFER` for an event or offer, and
`callToActionType` for a button. Telegram posts can only be created in the
AdaptlyPost app.

`firstComments` adds a comment from the same account right after the post goes
out on LinkedIn and YouTube, or a reply on X, Threads, Bluesky and Mastodon. A
failed comment never fails the post.

To add music to an Instagram Reel, find an `audioId` with
`adaptlypost_search_instagram_audio` and pass it in `instagramConfigs[].audio`.
It works for Instagram accounts connected through Facebook, which
`adaptlypost_accounts` marks with `supportsInstagramAudio: true`.

`recurrence` on `adaptlypost_create_post` repeats a post daily, weekly,
monthly or yearly. It needs mode SCHEDULE, since the first post sets the time of day, and
it cannot include TikTok. X and LinkedIn reject repeated identical text, so put
spintax such as `{Hi|Hello}` in the caption. Editing a series or skipping one
date happens in the AdaptlyPost app.

Media has to reach storage before the post references it. `adaptlypost_upload_media`
does the presign and the PUT together, so a post that names an unstored file
fails with "Media file(s) not found in storage".

`adaptlypost_validate_post` takes the same parameters as
`adaptlypost_create_post` and creates nothing. It runs every check the create
call runs, plus the ones that usually fail only at publish time: TikTok creator
limits, the YouTube upload quota, expired Instagram and Threads tokens, Pinterest
boards and X credits. Each account comes back `READY`, `WARNING` or `BLOCKED`
with the issues to fix. A post the create call refuses for its content answers
400 `post_validation_failed`, and the plugin passes on every issue in the error.

Every platform publishes on its own. Read `adaptlypost_post_results` per
platform rather than treating a post as one pass or fail. A platform
restriction is that platform's decision about the account, and retrying will
not clear it. A dead token or rejected media will.

Analytics cover Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky,
YouTube, X, LinkedIn and Google Business Profile. Google Business Profile
reports how often the location was seen, with no numbers per post. Mastodon and
Telegram have no analytics, so they come back empty. Connecting an account
imports its posts from the last 180 days, and analytics are kept from then on
while it stays connected. A `null` metric means
the platform does not report it, which is not the same as zero.

The API allows 600 requests per minute per token. A 429 comes back with
`Retry-After` and the plugin surfaces it rather than hammering.

## Notes for anyone building an OpenClaw plugin

`openclaw.compat.pluginApi` in `package.json` is a semver **range matched against
the host version**, and the host version is the OpenClaw release, `2026.8.1`. The
`"1.0.0"` that appears in published examples can never match it, and the install
fails with `requires plugin API 1.0.0, but this OpenClaw runtime exposes
2026.8.1`. Use `">=2026.8.0"`.

Two more, both caught by typechecking against OpenClaw's own `.d.ts` rather than
the docs:

1. `registerTool` takes a SINGLE object. Its `parameters` field is a **TypeBox**
   schema, not JSON Schema, and the real fields are `name`, `label`,
   `description`, `parameters` and `execute`.
2. `definePluginEntry` requires `id`, `name` and `description` alongside
   `register`.

A manifest `id` that differs from the npm package name is fine. The installer
warns and uses the manifest id as the config key, which is why the config block
above says `adaptlypost` and not `@adaptlypost/openclaw-plugin`.

## Develop

```bash
npm install
npm run build
openclaw plugins install --link . --force --accept-capabilities
openclaw plugins inspect adaptlypost --runtime --json
```

Needs Node `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`. `npm install` runs
OpenClaw's version guard on postinstall and stops outside that range.

MIT licensed. Source: [adaptlypost/adaptlypost-openclaw](https://github.com/adaptlypost/adaptlypost-openclaw)
