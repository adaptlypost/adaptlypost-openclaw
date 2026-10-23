# Platform-Specific Configs Reference

Platform configs are passed as arrays in both `POST /social-posts` and `POST /social-posts/bulk` request bodies (`googleBusinessConfigs` included), except `linkedinConfigs`, which only `POST /social-posts` and `PATCH /social-posts/:id` take (bulk cannot carry `DOCUMENT` posts). Each config object is tied to a specific connection via `connectionId` (or `pageId` for Facebook — set it to the same value you put in the top-level `pageIds` array, i.e. the Facebook account's `id` from `/social-accounts`).

For bulk scheduling, configs can be set at two levels:
- **Batch-level** (top-level request body) — applied to all posts as the default
- **Per-post** (inside individual post items) — overrides batch-level for that specific post

## TikTok — `tiktokConfigs`

```json
{
  "tiktokConfigs": [
    {
      "connectionId": "tiktok-connection-id",
      "privacyLevel": "PUBLIC_TO_EVERYONE",
      "title": "Video title",
      "caption": "Extended caption text",
      "allowComments": true,
      "allowDuet": true,
      "allowStitch": true,
      "sendAsDraft": false,
      "aiGenerated": false,
      "brandedContent": false,
      "brandedContentOwnBrand": false,
      "autoAddMusic": false
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionId` | string | **yes** | TikTok account connection ID |
| `privacyLevel` | string | **yes** | `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY` |
| `title` | string | no | Video title (max 90 chars) |
| `caption` | string | no | Extended caption (max 2,200 chars) |
| `allowComments` | boolean | no | Allow comments on the video |
| `allowDuet` | boolean | no | Allow duets |
| `allowStitch` | boolean | no | Allow stitches |
| `sendAsDraft` | boolean | no | Save as draft in TikTok app |
| `aiGenerated` | boolean | no | Mark content as AI-generated |
| `brandedContent` | boolean | no | Sponsored/partnership content |
| `brandedContentOwnBrand` | boolean | no | Self-promotional content |
| `autoAddMusic` | boolean | no | Auto-add background music |

**Media notes:**

- Video: MP4/MOV, H.264, max 250MB, 3s-10min. Best: 15-30s, 1080x1920 (9:16)
- Carousels: 2-35 images (photo slideshows)
- Caption: max 2,200 characters

## Instagram — `instagramConfigs`

```json
{
  "instagramConfigs": [
    {
      "connectionId": "instagram-connection-id",
      "postType": "REEL"
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionId` | string | **yes** | Instagram account connection ID |
| `postType` | string | no | `FEED`, `REEL`, or `STORY`. Default: `FEED` |
| `trialGraduation` | string | no | Publish the reel as a trial reel. `MANUAL`: you share it to followers from the Instagram app. `SS_PERFORMANCE`: Instagram shares it if it performs well |
| `shareToStory` | boolean | no | Also publish the same media as a story next to the `FEED` or `REEL` post. Ignored when `postType` is `STORY` |
| `collaborators` | string[] | no | Up to 3 Instagram usernames invited as collaborators. A leading `@` is stripped and duplicates are dropped |
| `userTags` | object[] | no | Up to 20 public accounts tagged in the media, each `{ "username": "...", "x": 0.5, "y": 0.3 }`. See [User tags](#user-tags) |
| `aiGenerated` | boolean | no | Disclose that the post was made or edited with AI. Instagram shows its "AI info" label on the post. Works on images, carousels, reels and stories, and a story made with `shareToStory` carries the label too |
| `audio` | object | no | Music or an original sound added to a Reel. See [Audio](#audio) |

**Content types:**

- **FEED**: Feed posts. Single image, carousel (up to 10 images and videos), or video up to 15 minutes
- **REEL**: Video up to 15 minutes, 9:16 recommended. Needs `contentType: VIDEO`
- **STORY**: 24-hour temporary content. `IMAGE`, `VIDEO` or `CAROUSEL`; a carousel story publishes each item as its own story, in order

**Share to story:** `shareToStory: true` publishes the same media as a story too. The story is its own entry in the post's `platforms` with `postType: STORY`, so it succeeds, fails and retries on its own. It skips the caption, first comment, cover, collaborators, user tags, trial and audio, needs `IMAGE`, `VIDEO` or `CAROUSEL`, and a story video must be 60 seconds or shorter.

**Collaborators:** work on feed images, carousels and reels. A story or a trial reel with collaborators returns `400`. Each collaborator gets an invite in Instagram and must accept it before the post shows on their profile.

#### User tags

```json
{
  "connectionId": "instagram-connection-id",
  "postType": "FEED",
  "userTags": [
    { "username": "jane.doe", "x": 0.25, "y": 0.6 },
    { "username": "@acme", "x": 0.7, "y": 0.4 }
  ]
}
```

- `username`: a public Instagram username, 1 to 30 letters, digits, dots or underscores. A leading `@` is stripped and a repeated username keeps its first entry.
- `x`, `y`: where the tag sits, from 0 to 1 across the image from the top-left corner (`x` left to right, `y` top to bottom).
- Tags work on one image (feed or story) or one video (Reel or story). A carousel or several stories with tags returns `400`.
- On a feed image every tag needs both `x` and `y`, or the API returns `400`. On a story they are optional, but a tag with only one of them returns `400`. On a video they are ignored and the person is tagged on the video as a whole.
- If Instagram refuses a tag because the account is private or doesn't exist, the post goes out without its tags and `instagramUntaggedUsernames` lists the refused usernames.
- The story that `shareToStory` adds does not carry the tags.
- The post reads them back as `instagramUserTags` on each Instagram platform entry.

#### Audio

```json
{
  "connectionId": "instagram-connection-id",
  "postType": "REEL",
  "audio": { "audioId": "1234567890", "title": "Summer Nights", "artist": "The Band", "audioVolume": 80, "videoVolume": 30 }
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `audioId` | string | **yes** | From `GET /social-accounts/:id/instagram-audio` (max 64 chars) |
| `title` | string | no | Track title, stored for display only (max 255 chars) |
| `artist` | string | no | Artist or creator, stored for display only (max 255 chars) |
| `audioVolume` | integer | no | Volume of the added audio, 1-100. Default: 100 |
| `videoVolume` | integer | no | Volume of the video's own sound, 1-100. Default: 100 |

Needs `contentType: VIDEO`, a `postType` other than `STORY`, and an account whose `supportsInstagramAudio` is `true` in `/social-accounts` (connected through Facebook).

**Trial reels:** Instagram shows a trial reel to non-followers first and keeps it off your followers' feeds and your profile grid until it is shared. Only a single video posted as `REEL` or `FEED` can be a trial; a story, image or carousel with `trialGraduation` is rejected with a 400. The account must be a professional account that Instagram has enabled for trial reels, otherwise the Instagram platform fails with a message saying so.

**Media notes:**

- Video: max 1GB, up to 15 minutes for feed videos and Reels
- Carousels: up to 10 images or videos

## Facebook — `facebookConfigs`

```json
{
  "facebookConfigs": [
    {
      "pageId": "FACEBOOK_ACCOUNT_ID_FROM_SOCIAL_ACCOUNTS",
      "postType": "REEL",
      "videoTitle": "My Video Title"
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pageId` | string | **yes** | Same value as in the top-level `pageIds` array (the Facebook account's `id` from `/social-accounts`) |
| `postType` | string | no | `FEED`, `REEL`, or `STORY`. Default: `FEED` |
| `videoTitle` | string | no | Video title (max 255 chars) |
| `shareToStory` | boolean | no | Also publish the same media as a story next to the `FEED` or `REEL` post. Ignored when `postType` is `STORY` |
| `textFormatPresetId` | string | no | Facebook's id for a colored text background (digits, 1-20), for example `106018623298955` (solid purple) or `249307305544279` (red to blue gradient) |
| `imageLayout` | string | no | `GRID` (photo grid) or `CAROUSEL` (swipeable cards, each opening its own link). Default: `GRID` |
| `carouselCards` | array | no | Up to 5 cards, one per image in the same order as `mediaUrls`: `link` (**required**, http or https URL, max 2048 chars), `title` (max 100 chars), `description` (max 200 chars). Only read when `imageLayout` is `CAROUSEL` |

**Content types:**

- **FEED**: Permanent feed content. Up to 10 images OR 1 video. Text limit: 63,206 chars
- **REEL**: Short-form vertical video
- **STORY**: 24-hour temporary content. `IMAGE`, `VIDEO` or `CAROUSEL`; a carousel story publishes each item as its own story

**Share to story:** the story is its own entry in the post's `platforms` with `postType: STORY`. It skips the caption, video title and text background, needs `IMAGE`, `VIDEO` or `CAROUSEL`, and a story video must be 60 seconds or shorter.

**Text background:** only for `contentType: TEXT` with no media and text up to 130 characters; anything else returns `400`. Links in the text show without a preview. If Facebook refuses the background, the post goes out as plain text.

**Link carousel:** `imageLayout: CAROUSEL` needs `postType: FEED`, 2 to 5 images, no videos and one `carouselCards` entry per image; anything else returns `400`. Facebook shows a card's image and title only when its link goes to a website the Page owns. Any other link makes the post fail with a message saying so. Posts that leave out `imageLayout` get a photo grid.

**Media notes:**

- Images: JPG/PNG, max 30MB each, up to 10 per post
- Cannot mix images and videos in same post

## YouTube — `youtubeConfigs`

```json
{
  "youtubeConfigs": [
    {
      "connectionId": "youtube-connection-id",
      "postType": "SHORTS",
      "videoTitle": "My Video Title",
      "tags": ["tutorial", "howto"],
      "privacyStatus": "public",
      "license": "youtube",
      "notifySubscribers": true,
      "allowEmbedding": true,
      "madeForKids": false,
      "aiGenerated": false,
      "categoryId": "22",
      "playlistId": "PLxxxxxxxx"
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionId` | string | **yes** | YouTube channel connection ID |
| `postType` | string | no | `VIDEO` or `SHORTS`. Default: `VIDEO` |
| `videoTitle` | string | no | Video title (max 100 chars) |
| `tags` | string[] | no | Video tags (max 20 tags) |
| `privacyStatus` | string | no | `public`, `private`, or `unlisted`. Default: `public` |
| `license` | string | no | `youtube` or `creativeCommon` |
| `notifySubscribers` | boolean | no | Notify subscribers on publish |
| `allowEmbedding` | boolean | no | Allow embedding on other sites |
| `madeForKids` | boolean | no | COPPA compliance flag |
| `aiGenerated` | boolean | no | Disclose altered or synthetic content, such as an AI voice, an AI avatar or realistic footage that was generated or edited. YouTube shows its "Altered or synthetic content" label on the video. Sets `status.containsSyntheticMedia`. Omit it or send `false` for no label. Works on videos and Shorts |
| `categoryId` | string | no | YouTube category ID |
| `playlistId` | string | no | Add to playlist after publishing |

**Media notes:**

- Shorts: up to 3 minutes, 9:16 or 1:1
- Copyrighted music limits Shorts to 60 seconds
- H.264 video codec with AAC audio recommended

## Pinterest — `pinterestConfigs`

```json
{
  "pinterestConfigs": [
    {
      "connectionId": "pinterest-connection-id",
      "boardId": "board-id-here",
      "title": "Pin Title",
      "link": "https://example.com/page"
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionId` | string | **yes** | Pinterest account connection ID |
| `boardId` | string | no | Board `id` from `GET /social-accounts/:id/pinterest-boards`. Not together with `boardName`. Without either, the pin goes to a public board named "AdaptlyPost", created on the Pinterest account the first time it is needed |
| `boardName` | string | no | The board's name on this Pinterest account (1 to 180 characters), used instead of `boardId`. Names are trimmed; a single exact match wins, then a single case-insensitive match. `400` when no board has the name, when several share it (the message lists their ids), or when `boardId` is also set. Never falls back to another board. Not stored: the post keeps the resolved board id |
| `title` | string | no | Pin title (max 100 chars) |
| `link` | string | no | Destination URL when pin is clicked (must be valid URL) |

**Media notes:**

- Ideal aspect ratio: 2:3 (1000x1500)
- Carousels: 2-5 static images only (no video in carousels)

## LinkedIn — `linkedinConfigs`

Only used for `DOCUMENT` posts: one PDF, PPT, PPTX, DOC or DOCX file (max 100 MB, 300 pages) that LinkedIn shows as a swipeable document. Target only `LINKEDIN` and put the single file URL in `mediaUrls`.

```json
{
  "contentType": "DOCUMENT",
  "mediaUrls": ["https://cdn.adaptlypost.com/social-media-posts/uuid/q3-results.pdf"],
  "linkedinConnectionIds": ["linkedin-connection-id"],
  "linkedinConfigs": [
    {
      "connectionId": "linkedin-connection-id",
      "documentTitle": "Q3 results"
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionId` | string | **yes** | LinkedIn account connection ID |
| `documentTitle` | string | no | Title shown on the document (max 100 chars). Defaults to the file name; ignored for other content types |

LinkedIn text, image and video posts need no config object.

## Google Business Profile — `googleBusinessConfigs`

One entry per location in `googleBusinessConnectionIds`. A location without an entry gets a `STANDARD` update.

```json
{
  "googleBusinessConnectionIds": ["gbp-location-id"],
  "googleBusinessConfigs": [
    {
      "connectionId": "gbp-location-id",
      "topicType": "OFFER",
      "eventTitle": "Autumn sale",
      "eventStart": "2026-10-20",
      "eventEnd": "2026-10-31",
      "offerCouponCode": "AUTUMN20",
      "offerRedeemUrl": "https://example.com/sale",
      "offerTerms": "One per customer",
      "callToActionType": "SHOP",
      "callToActionUrl": "https://example.com/sale"
    }
  ]
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionId` | string | **yes** | Google Business Profile location `id` from `/social-accounts` |
| `topicType` | string | **yes** | `STANDARD` (an update), `EVENT` or `OFFER`. `EVENT` and `OFFER` need `eventTitle`, `eventStart` and `eventEnd` |
| `callToActionType` | string | no | Button on the post: `BOOK`, `ORDER`, `SHOP`, `LEARN_MORE`, `SIGN_UP` or `CALL`. Every type except `CALL` needs `callToActionUrl`; `CALL` dials the phone number on the Business Profile |
| `callToActionUrl` | string | no | URL the button opens. Ignored for `CALL` |
| `eventTitle` | string | no | Event or offer title |
| `eventStart` | string | no | `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` in the business's local time, no offset |
| `eventEnd` | string | no | `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` in the business's local time, no offset |
| `offerCouponCode` | string | no | `OFFER` only |
| `offerRedeemUrl` | string | no | `OFFER` only: URL where the offer is redeemed |
| `offerTerms` | string | no | `OFFER` only: terms and conditions |

**Media notes:**

- `contentType` `TEXT` or `IMAGE` only, with one JPEG or PNG image up to 5 MB
- Text up to 1,500 characters
- No alt text
- Analytics report location-level impressions only; posts have no per-post numbers

## Platforms Without Config Objects

These platforms use only connection ID arrays — no additional config:

### X (Twitter)

- Uses `twitterConnectionIds` array
- Character limit: 280
- Up to 4 images per post
- No video support via this API
- Links in X text are broken by default (`example.com` becomes `example. com`) because X charges over 10 times more for a post with a link. Top-level `twitterKeepLinks: true` keeps them clickable, on AppSumo lifetime deals only, at 20 credits instead of 2

### Bluesky

- Uses `blueskyConnectionIds` array
- Character limit: 300
- Up to 4 images
- No video support
- URLs auto-generate link cards
- No editing after publishing

### Mastodon

- Uses `mastodonConnectionIds` array
- Character limit: 500 by default, some servers allow more
- Up to 4 images, some servers allow more
- 1 video per post
- Alt text supported
- No analytics

### Threads

- Uses `threadsConnectionIds` array
- Text + images + video supported
- Carousels: up to 10 images and videos

### LinkedIn

- Uses `linkedinConnectionIds` array
- Character limit: 3,000 (under 1,300 performs better)
- Carousel of up to 20 images, or video up to 10 min, or one document (see `linkedinConfigs` above)
- Put links in a first comment (`firstComments`), not the post body, because LinkedIn deprioritizes external links
- Mention a company page with `@[Page Name](urn:li:organization:<id>)`, the page name exactly as LinkedIn shows it
- 3-5 hashtags max

### Telegram

Telegram posts can only be created in the AdaptlyPost app. The API lists them on posts but cannot post to Telegram, and Telegram has no analytics.
