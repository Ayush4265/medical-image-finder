# Medical Image Finder for Obsidian

A dedicated Windows Obsidian plugin that enables medical students and clinicians to search, preview, copy, save, and AI-audit medical reference images directly from their notes.

## Key Features (v2.0)

- **⚡ Fast Batch Review & Multi-Select**: Review all AI visual opportunities at once in an interactive modal. Features smooth horizontal mouse-wheel scrolling across all returned images and allows toggling 1 or more images per query for automated bottom-to-top batch insertion with zero line drift.
- **📐 Smart List Continuation & Clean Embeds**: Images inserted under list items or sub-bullets automatically inherit the exact indentation of the bullet point, eliminating syntax corruption and preventing subsequent bullet points from turning into indented code blocks. Intrusive caption text is omitted for clean reading.
- **🌐 Double-Click to Open Source**: Double-clicking any image in the search grid, fast batch review modal, inline cards, or full-screen preview opens the original source article or website directly in your browser.
- **🔍 Bright Data Google Images Integration**: Added support for Bright Data SERP API, giving you 5,000 free Google Images queries per month with high-resolution original images and instant preview thumbnails.
- **✨ Multi-Backend AI Note Visual Scanner**:
  - Automatically identifies sections lacking illustrations and flags high-yield visual gaps (surgical triangles, operative repairs, anatomical layers, pathognomonic radiological signs, histology).
  - Supports **Google Gemini** (Gemini 2.5 Flash, 2.5 Pro, 3.6 Flash, etc.), **Groq** (Llama 3.1 8B Instant), **OpenRouter**, or an **Offline Heuristic Scanner** requiring zero API keys.
  - Generates custom AI prompt templates with `[L<number>]` line mapping for external LLM chat interfaces (Alt+G).
- **Zero-Setup Search Out-of-the-Box**: Uses DuckDuckGo Image Search by default — no API keys, accounts, or subscriptions needed.
- **Medical Visual Mode Quick-Filters**: 1-click filter pills in the sidebar header to instantly target:
  - `[All]`: Raw search terms without modifier.
  - `[Atlas / Diagram]`: Anatomical illustrations and labeled textbook figures.
  - `[Radiology]`: Plain radiographs, CT, MRI, and contrast imaging.
  - `[Histology]`: High-power microscopy, H&E staining, and pathology biopsies.
  - `[Clinical / Surgical]`: Operative and laparoscopic fields of view.
- **Multi-Provider Support**: Switch easily between DuckDuckGo, Wikimedia Commons, Bright Data (5,000 free/mo), Google Custom Search (CSE), SerpApi Google Images, and Brave Search.
- **1-Click Clipboard Copy**: Click **📋 Copy image** directly on any result card to decode and place the high-resolution image directly onto your Windows clipboard. Press `Ctrl + V` anywhere in your note (or external apps like Anki) to paste.
- **1-Click Offline Vault Save & Insert**: Click **📥 Insert in note** to download the original image into your vault's `Attachments/MedicalImages/` folder with unique content hashing and embed `![[Attachments/MedicalImages/...|500]]` directly beneath the selected sentence or paragraph.
- **Interactive Sidebar & Full-Size Preview**: Docked right sidebar keeps your note visible side-by-side with high-resolution image cards, dimension tags, domain sources, and a zoomable modal.
- **Editor Context Menu & Command Palette**: Select text in your note (e.g. `borders of triangle of doom and pain`), right-click and choose **Find images for selection**, or press `Ctrl + P` and run **Find images**.

## How to Use

### 1. Searching & Inserting Images
1. **Highlight Medical Text**: Select anatomical terms or surgical concepts in your note (e.g., `borders of triangle of doom and pain`).
2. **Open & Search**:
   - Right-click → **Find images for "..."**
   - *OR* in the sidebar search bar, click `📋` to paste your note's selection directly!
3. **Choose & Insert**:
   - Click **📋 Copy image** to copy to clipboard, then press `Ctrl + V` anywhere in your note.
   - *OR* click **📥 Insert in note** to permanently save it in `Attachments/MedicalImages/` and embed it beside the explanation.

### 2. Scanning Notes with AI (Gemini)
1. In the sidebar header, click the **✨ AI Visual Scanner** tab (or press `Ctrl + P` → run **Scan note for visual opportunities (AI)**).
2. Click **⚡ Scan Active Note**.
3. Review the generated visual opportunities list:
   - Click **🔍 Search this** to open results in the search tab with pre-filled query and category filter.
   - Click **⚡ Quick find** to see top 3 image choices inline on the card for 1-click copy or insert!
   - Click **📍 Line X** to jump directly to that heading in your note.

## Provider Options & Settings

- **DuckDuckGo (Default)**: No API key required; availability and rate limits depend on DuckDuckGo. If the request fails, the plugin tries Wikimedia Commons and identifies the fallback in its status.
- **Wikimedia Commons**: Free, public domain and Creative Commons medical atlas diagrams.
- **Gemini AI Note Scanner**: Free API key from [Google AI Studio](https://aistudio.google.com/app/apikey) with a model selector and a Fetch models button. Model availability depends on your account; use Fetch models to refresh the list.
- **Google Custom Search Engine (CSE)**: Optional Google Cloud API Key + Search Engine ID (100 free searches/day).
- **Google Images via SerpApi**: Optional SerpApi key for direct Google Images scraping results.
- **Brave Search API**: Optional Brave Image search subscription token.

## Reliability and verification

- Search text survives filter/tab changes, and only the newest request can update results.
- Ordinary insertion follows the last focused Markdown note. Clicking Insert freezes the note and insertion position; if its contents change before insertion, retry.
- Scanner results retain their original note. Rescan if that note changes or closes before jumping or inserting.
- Downloads are decoded before copying or saving. PNG, JPEG, GIF, and WebP keep their format; other decodable images are saved as PNG. Invalid originals fall back to the thumbnail when available.
- Vault writes preserve existing files. If the note changes after the image has been saved, insertion is stopped; the saved attachment remains available.
- API keys remain in Obsidian's plugin settings file; displayed errors redact known keys and request URLs.

Run `npm test` for mocked regression tests and `npm run check` for syntax validation (Node.js 18 or newer). Live provider availability, Electron image decoding, and Obsidian UI behavior also need a desktop smoke test.
