# Medical Image Finder for Obsidian

A dedicated Windows Obsidian plugin that enables medical students and clinicians to search, preview, copy, save, and AI-audit medical reference images directly from their notes.

## Key Features (v2.6)

- **🎯 Partial-Note AI Scanning & Bounded Insertion**: Scan only a highlighted selection, a specific `# Heading` section, or a custom line range (`From L__ To L__`) using external AI (`Alt+G` / clipboard bridge), API backends, or the Offline Scanner. Preserves original `[L<number>]` prefixes, filters out-of-scope suggestions, and locks insertion strictly within the scanned range. Includes a right-click **📋 Scan selected part with AI (Alt+G)** menu option and Command Palette shortcut.
- **🖼️ Large In-App Lightbox Preview (No Unwanted Browser Tabs)**: Double-clicking any image in Search results, Scanner Inline Quick Find, or Fast Batch opens a large in-Obsidian preview (`ImagePreviewModal`) with double-click / button **2× Zoom**, keyboard navigation (`←` / `→`), `Z` zoom toggle, and `Space` batch selection toggle. Source webpages open on demand via explicit `🌐 Open source page` / `🌐` buttons.
- **⚡ Fast Batch Review (`S / M / L / XL`, Aspect-Ratio Fit & Multi-Select)**: Review all AI visual opportunities in a responsive modal with persistent **S / M / L (default) / XL** thumbnail sizes, uncropped aspect-ratio horizontal scrolling, hover `🔍` preview button, accidental double-click toggle protection, fixed `0/N` fetch progress bar, and bottom-to-top batch insertion with zero line drift.
- **🔍 High-Resolution Bright Data Google Images (`udm=2` + `parsed_light`)**: Automatically requests Light JSON (`parsed_light`) with `udm=2` to fetch up to 100 full-resolution `original_image` URLs and true pixel dimensions (`original_width` × `original_height`), deprioritizes tiny icons/thumbnails, and renders full-resolution previews with live resolution badges (`< 250px` low-res warnings) and safe fallback without false low-res stamps.
- **🏷️ Scanner Category Filter Pills**: Filter visual suggestions in one click (`All`, `Pending`, `Diagram`, `Radiology`, `HPE`, `Clinical`, `Criteria`, `Embryology`) while keeping original note references intact.
- **📐 Smart List Continuation & Clean Embeds**: Images inserted under list items or sub-bullets automatically inherit the exact indentation of the bullet point, eliminating syntax corruption and preventing subsequent bullet points from turning into indented code blocks. Intrusive caption text is omitted for clean reading.
- **✨ Multi-Backend AI Note Visual Scanner**:
  - Automatically identifies sections lacking illustrations and flags high-yield visual gaps (surgical triangles, operative repairs, anatomical layers, pathognomonic radiological signs, histology).
  - Supports **Google Gemini** (Gemini 2.5 Flash, 2.5 Pro, etc.), **Groq** (Llama 3.1 8B Instant), **OpenRouter**, or an **Offline Heuristic Scanner** requiring zero API keys.
  - Generates custom AI prompt templates with `[L<number>]` line mapping for external LLM chat interfaces (`Alt+G`).
- **Zero-Setup Search Out-of-the-Box**: Uses DuckDuckGo Image Search by default — no API keys, accounts, or subscriptions needed.
- **Medical Visual Mode Quick-Filters**: 1-click filter pills in the sidebar header to instantly target `[All]`, `[Atlas / Diagram]`, `[Radiology]`, `[Histology]`, `[Clinical / Surgical]`, `[Criteria / Scoring]`, and `[Embryology / Physio]`.
- **Multi-Provider Support**: Switch easily between DuckDuckGo, Bright Data (5,000 free/mo), Wikimedia Commons, Google Custom Search (CSE), SerpApi Google Images, and Brave Search.
- **1-Click Clipboard Copy & Offline Vault Insert**: Click **📋 Copy image** to copy decoded images to the Windows clipboard, or **📥 Insert in note** to store hashed files inside `Attachments/MedicalImages/` and embed cleanly (`![[Attachments/MedicalImages/...|500]]`).
- **Editor Context Menu & Command Palette**: Select text in your note, right-click for **Find images for "..."** or **📋 Scan selected part with AI (Alt+G)**, or trigger commands via `Ctrl + P`.

## What's New in v2.6.0

- **Partial-Note Scanning**: Added full UI scope picker (`Full Note`, `Selection`, `# Heading Section`, `Custom L__–L__`), editor right-click scoped `Alt+G` trigger, scope pill badges, and hard insertion boundary clamping.
- **In-App Big Preview & Keyboard Navigation**: Replaced double-click-to-browser with in-app lightbox zoom (`←`/`→`, `Z`, `Space`, double-click 2× zoom) and moved browser launch to explicit `🌐` buttons.
- **Fast Batch Overhaul**: Added `S / M / L / XL` thumbnail switcher (default Large `230px`), uncropped `object-fit: contain` aspect-ratio tiles, hover `🔍` zoom, accidental double-click toggle rollback, and fixed the `3/N` progress bar jump bug so progress starts at `0/N`.
- **Bright Data Full-Resolution Fix**: Upgraded `BrightDataProvider` to `&udm=2` + `data_format: "parsed_light"`, prioritized high-res `original_image` results with `original_width`/`original_height`, upgraded raw HTML tuple fallback, and fixed UI preview/dimension loading so hotlink-protected thumbnails don't stamp false `225px` low-res warnings.
- **Scanner & UX Polish**: Added Scanner category filter pills (`All`, `Pending`, categories), live natural dimension & `< 250px` low-res badges, and kept `styles.css` 100% free of Obsidian CSS lint warnings.

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
