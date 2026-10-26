# Medical Image Finder for Obsidian

A dedicated Windows Obsidian plugin that enables medical students and clinicians to search, preview, copy, and save medical reference images directly from their notes.

## Key Features

- **Zero-Setup Search Out-of-the-Box**: Uses DuckDuckGo Image Search by default — no API keys, accounts, or subscriptions needed.
- **Medical Visual Mode Quick-Filters**: 1-click filter pills in the sidebar header to instantly target:
  - `[All]`: Raw search terms without modifier.
  - `[Atlas / Diagram]`: Anatomical illustrations and labeled textbook figures.
  - `[Radiology]`: Plain radiographs, CT, MRI, and contrast imaging.
  - `[Histology]`: High-power microscopy, H&E staining, and pathology biopsies.
  - `[Clinical / Surgical]`: Operative and laparoscopic fields of view.
- **Multi-Provider Support**: Switch easily between DuckDuckGo, Wikimedia Commons, Google Custom Search (100 free queries/day), SerpApi Google Images, and Brave Search.
- **1-Click Clipboard Copy**: Click **📋 Copy image** directly on any result card to decode and place the high-resolution image directly onto your Windows clipboard. Press `Ctrl + V` anywhere in your note (or external apps like Anki) to paste.
- **1-Click Offline Vault Save & Insert**: Click **📥 Insert in note** to download the original image into your vault's `Attachments/MedicalImages/` folder with unique content hashing and embed `![[Attachments/MedicalImages/...|500]]` directly beneath the selected sentence or paragraph.
- **Interactive Sidebar & Full-Size Preview**: Docked right sidebar keeps your note visible side-by-side with high-resolution image cards, dimension tags, domain sources, and a zoomable modal.
- **Editor Context Menu & Command Palette**: Select text in your note (e.g. `borders of triangle of doom and pain`), right-click and choose **Find images for selection**, or press `Ctrl + P` and run **Find images**.

## How to Use

1. **Select Medical Text**: Highlight anatomical terms, pathologies, or surgical landmarks (e.g., `borders of triangle of doom and pain`, `femoral canal boundaries`, `Wiggers diagram`).
2. **Run Find Images**:
   - Right-click the highlighted text → **Find images for "..."**
   - OR press `Ctrl + P` → run **Find images**
   - OR click the image icon in the left ribbon.
3. **Choose Your Image**:
   - The right sidebar opens with image results.
   - Click **📋 Copy image** to copy to clipboard, then paste with `Ctrl + V` anywhere you like.
   - OR click **📥 Insert in note** to permanently save the image offline in your vault attachments folder and insert it beside the selected text.
   - Click **🔍 Preview full size** to inspect fine anatomical labels and high-resolution details.

## Provider Options (Settings -> Medical Image Finder)

- **DuckDuckGo (Default)**: No API key required; availability and rate limits depend on DuckDuckGo.
- **Wikimedia Commons**: Images from Wikimedia Commons; check each image license.
- **Google Custom Search Engine (CSE)**: Optional Google Cloud API Key + Search Engine ID (100 free searches/day).
- **Google Images via SerpApi**: Optional SerpApi key for direct Google Images scraping results.
- **Brave Search API**: Optional Brave Image search subscription token.

## Author

Atharva Savnerkar ([Ayush4265](https://github.com/Ayush4265)).

## Installation

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release. Place them in `<vault>/.obsidian/plugins/medical-image-finder/`, restart Obsidian, and enable Medical Image Finder in Settings → Community plugins.

## Privacy and network access

Searches send the selected text or entered query and chosen filter terms to the selected search provider. Result previews load images from third-party hosts; copying or inserting downloads the selected image. Do not search confidential patient information. Optional provider credentials are stored in Obsidian's local plugin settings (`data.json`); they are not included in this repository. No analytics are added by this plugin.

## Image usage

Search results remain subject to their original licenses. Check the source page and attribution requirements before reusing an image. Search results are reference material and are not verified clinical guidance. Provider availability, quotas, and charges may change.

## Development

`main.js` is the directly maintained JavaScript source; no compilation or dependency installation is required. Run `node --check main.js` to check its syntax. This plugin uses Electron and Node APIs and supports desktop Obsidian only.

