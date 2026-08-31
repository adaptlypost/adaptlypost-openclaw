# AdaptlyPost plugin for OpenClaw

Schedule and publish social posts to LinkedIn, X, Instagram, Facebook, TikTok,
YouTube, Pinterest, Threads and Bluesky, from inside OpenClaw.

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
        config: { apiToken: "adaptly_..." }
      }
    }
  }
}
```

The token decides the account group, so you never pass an account id. Connect
only the accounts the agent actually needs, since the token reaches every
account in the group.

## Tools

| tool | what it does |
|---|---|
| `adaptlypost_accounts` | List connected accounts and their connection ids. Call this first. |
| `adaptlypost_upload_media` | Upload local files or remote URLs, returns public media URLs. |
| `adaptlypost_create_post` | Create, schedule, or draft one post across any set of accounts. |
| `adaptlypost_list_posts` | List posts, including scheduled and draft. |
| `adaptlypost_post_results` | Read the per-platform result for one post. |
| `adaptlypost_retry_failed` | Retry only the platforms that failed. |

Six tools, not the twelve the API exposes. Post editing, deletion, draft
publishing and bulk scheduling stay out, because an agent picking from a long
list of near-identical tools picks worse. Those live in the
[MCP server](https://github.com/TarasShyn/adaptlypost-mcp) and the REST API.

## Things worth knowing

Connection ids are per platform and go in the matching array, so a LinkedIn id
belongs in `linkedinConnectionIds`. Facebook is the exception: pages have no
username, so they carry a `pageId` and go in `pageIds`.

TikTok needs `privacyLevel` in `tiktokConfigs` and has no default. Pinterest
needs `boardId`. Both reject the post outright without them.

Media has to reach storage before the post references it. `adaptlypost_upload_media`
does the presign and the PUT together, so a post that names an unstored file
fails with "Media file(s) not found in storage".

Every platform publishes on its own. Read `adaptlypost_post_results` per
platform rather than treating a post as one pass or fail. A platform
restriction is that platform's decision about the account, and retrying will
not clear it. A dead token or rejected media will.

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
