# Protest Archive - Technical Design Document

> **Purpose:** Build a fast, low-cost, static website that documents publicly available videos, photos, and reporting related to a specific protest event. The primary objective is preservation, discoverability, and historical documentation. The site should clearly distinguish verified information from unverified material, preserve attribution, and avoid editorializing.

---

# Project Goals

## Primary Goals

- Preserve publicly available evidence.
- Make browsing effortless.
- Ensure the site loads extremely quickly.
- Keep infrastructure costs close to zero.
- Avoid maintaining backend servers.
- Make deployment simple.
- Allow the archive to scale to thousands of videos.

## Non Goals

- User accounts
- Comments
- Likes
- Uploads from visitors
- Realtime updates
- Complex backend APIs

---

# High Level Architecture

```
               Collection Scripts
                       │
        ┌──────────────┴──────────────┐
        │                             │
 Public URLs                   Downloaded Media
        │                             │
        └──────────────┬──────────────┘
                       │
               Metadata Generator
                       │
               JSON Manifest Files
                       │
          Static Frontend (Astro)
                       │
      Cloudflare Pages + Cloudflare R2
```

The website should be completely static.

The frontend should fetch JSON files and render the experience entirely client-side.

---

# Technology Stack

## Frontend

- Astro
- TypeScript
- TailwindCSS

Reason:

- Extremely fast
- Static output
- Excellent SEO
- Minimal JavaScript
- Easy deployment to Cloudflare Pages

---

## Hosting

Frontend

- Cloudflare Pages

Media Storage

- Cloudflare R2

Reason

- Global CDN
- Zero egress fees
- Very low cost
- Good performance worldwide

---

## No Backend

There should be:

- No Node server
- No Express
- No database
- No authentication
- No API

Everything should work through static JSON files.

---

# Folder Structure

```
archive/

    public/

        videos/
        thumbnails/

        data/

            videos.json
            timeline.json
            tags.json

    src/

        components/
        layouts/
        pages/

    scripts/

        download-media/
        generate-metadata/
        generate-thumbnails/

    package.json
```

---

# Data Model

## videos.json

```json
[
  {
    "id": "video-001",

    "title": "...",

    "description": "...",

    "date": "2026-07-20",

    "location": "Ahmedabad",

    "tags": [
      "police",
      "students"
    ],

    "verified": false,

    "verificationStatus": "unverified",

    "source": {
      "platform": "YouTube",
      "url": "...",
      "uploader": "...",
      "publishedAt": "..."
    },

    "media": {
      "video": "videos/video-001.mp4",
      "thumbnail": "thumbnails/video-001.jpg"
    }
  }
]
```

---

# Verification Levels

Every media item should explicitly show one of the following:

```
Verified

Likely Verified

Partially Verified

Unverified

Context Unclear
```

Never imply certainty where it does not exist.

---

# Homepage

The homepage should contain:

## Hero Section

Large autoplay banner video.

Includes

- Title
- Short introduction
- Timeline button
- Scroll indicator

---

Below the hero begins the infinite feed.

```
------------------------

Hero Video

------------------------

Video

------------------------

Video

------------------------

Video

------------------------

Video
```

---

# Video Feed

Each card occupies almost the full viewport.

```
+--------------------------------+

           VIDEO

Title

Source

Date

Tags

Verification Badge

Description

+--------------------------------+
```

Scrolling should feel similar to Instagram Reels or TikTok.

---

# Feed Behaviour

When a video becomes visible:

- play automatically

When it leaves screen:

- pause automatically

Preload:

- current
- next

Do not preload the entire archive.

Use:

Intersection Observer API

---

# Search

Future support.

Filter by

- tag
- location
- date
- platform
- verification status

Entirely client-side.

---

# Timeline Page

Example

```
08:30

Students gather

↓

09:05

Police arrive

↓

09:40

Detentions begin

↓

10:15

Crowd dispersed
```

Each event links to related media.

---

# Individual Video Page

Every video should have its own URL.

Example

```
/video/video-001
```

Contains

- video
- metadata
- original source
- uploader
- archive date
- verification level
- related videos

---

# Accessibility

Requirements

- Keyboard navigation
- Captions where available
- Alt text for images
- High contrast
- Mobile first

---

# Mobile Experience

The majority of users will likely be mobile.

Design mobile-first.

Desktop should simply expand the layout.

---

# Performance Goals

Target Lighthouse

Performance

100

Accessibility

100

Best Practices

100

SEO

100

---

Largest Contentful Paint

<2 seconds

---

# Image Strategy

Generate thumbnails.

Do NOT load videos until needed.

Use lazy loading.

---

# Video Strategy

Videos should be encoded as MP4 (H.264/AAC) for broad compatibility. If time permits, also generate WebM versions for browsers that support them.

For each video:

- Original archival copy (optional, stored separately if needed)
- Web playback version (compressed)
- Thumbnail

Only the playback version should be served by the website.

---

# Metadata Generator

Create scripts that automatically:

- generate thumbnails
- calculate duration
- calculate file size
- generate JSON
- detect duplicates
- optimize filenames

---

# Collection Pipeline

The collection process should be reproducible.

Suggested flow:

```
Public URL

↓

Download

↓

Normalize filename

↓

Generate thumbnail

↓

Compress for web

↓

Extract metadata

↓

Append to videos.json

↓

Ready to publish
```

Downloading should support multiple public platforms where legally and technically feasible, while respecting each platform's terms of service.

---

# Deployment

Deployment should be one command.

```
npm run build

↓

Static files

↓

Cloudflare Pages

↓

Done
```

No manual deployment steps.

---

# Future Features

## Map

Interactive map showing where media was captured.

---

## Related Videos

Show similar videos based on:

- time
- location
- tags

---

## Collections

Examples

- Police response
- Speeches
- Student march
- Interviews
- Media coverage

---

## Full Text Search

Client-side search using a lightweight search index.

---

## Statistics

Display counts such as:

- total videos
- total photos
- total sources
- total duration
- timeline coverage

---

# Design Principles

The interface should feel like a modern digital archive rather than a social media platform.

Prioritize:

- simplicity
- readability
- speed
- credibility
- source transparency
- clear distinction between verified facts and unverified material

Avoid:

- clickbait
- autoplay audio
- intrusive animations
- unnecessary visual effects

---

# Development Roadmap

## Phase 1

- Astro project
- Tailwind
- Hero section
- Video feed
- JSON metadata
- Cloudflare Pages deployment

---

## Phase 2

- Timeline
- Search
- Tags
- Filtering
- Individual video pages

---

## Phase 3

- Collection pipeline
- Metadata generation
- Thumbnail generation
- Video optimization

---

## Phase 4

- Interactive map
- Related videos
- Collections
- Statistics
- Duplicate detection

---

# Important Engineering Principles

- Keep everything static whenever possible.
- Prefer build-time generation over runtime computation.
- Use JSON instead of databases.
- Minimize JavaScript.
- Optimize for low operational cost.
- Design for long-term maintainability.
- Keep the architecture simple enough that a single developer can maintain it.
- Preserve attribution and context for all archived material.
- Clearly label verification status and link to original sources whenever possible.
