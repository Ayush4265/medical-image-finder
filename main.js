"use strict";

const {
  Plugin,
  ItemView,
  Modal,
  Notice,
  Setting,
  PluginSettingTab,
  normalizePath,
  TFile,
  MarkdownView,
  requestUrl
} = require("obsidian");
const electron = require("electron");
const crypto = require("node:crypto");

const VIEW_TYPE_MIF = "medical-image-finder-view";

const DEFAULT_SETTINGS = {
  defaultProvider: "duckduckgo",
  defaultFilterMode: "all",
  attachmentFolder: "Attachments/MedicalImages",
  defaultImageWidth: 500,
  includeCaption: true,
  googleApiKey: "",
  googleCx: "",
  serpApiKey: "",
  braveApiKey: ""
};

// Medical Visual Mode Quick-Filters
const MEDICAL_VISUAL_FILTERS = [
  { id: "all", label: "All", modifier: "" },
  { id: "diagram", label: "Atlas / Diagram", modifier: "labeled medical diagram anatomy" },
  { id: "radiology", label: "Radiology", modifier: "radiology CT MRI X-ray" },
  { id: "histology", label: "Histology", modifier: "histopathology microscopy H&E" },
  { id: "clinical", label: "Clinical / Surgical", modifier: "clinical operative surgical view" }
];

// Utilities
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$1 $2")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFileName(title) {
  const clean = cleanText(title)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 50)
    .replace(/-+$/, "");
  return clean || "medical-diagram";
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Robust Network fetcher using Obsidian requestUrl with Electron/Node fallback
async function fetchText(url, headers = {}) {
  try {
    const res = await requestUrl({
      url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...headers
      }
    });
    return res.text;
  } catch (err) {
    throw new Error(`Failed to load ${url}: ${err.message || err}`);
  }
}

async function fetchJson(url, headers = {}) {
  try {
    const res = await requestUrl({
      url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json",
        ...headers
      }
    });
    return res.json;
  } catch (err) {
    throw new Error(`API request failed: ${err.message || err}`);
  }
}

async function fetchBinary(url, headers = {}) {
  try {
    const res = await requestUrl({
      url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ...headers
      }
    });
    return res.arrayBuffer;
  } catch (err) {
    throw new Error(`Failed to download image: ${err.message || err}`);
  }
}

// -------------------------------------------------------------
// Search Providers
// -------------------------------------------------------------

// 1. DuckDuckGo Image Provider (Zero API Key, free, high quality)
class DuckDuckGoProvider {
  name = "DuckDuckGo (Free / No Key)";

  async search(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();

    // Step 1: Request DuckDuckGo page to retrieve the vqd token
    const tokenUrl = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`;
    const html = await fetchText(tokenUrl, {
      Referer: "https://duckduckgo.com/"
    });

    // Extract vqd token from HTML
    const vqdMatch =
      html.match(/vqd=["']?([a-zA-Z0-9_-]+)["']?/) ||
      html.match(/vqd:\s*['"]([^'"]+)['"]/);

    if (!vqdMatch || !vqdMatch[1]) {
      // Fallback: try DuckDuckGo HTML endpoint
      return await this.searchFallback(q);
    }

    const vqd = vqdMatch[1];

    // Step 2: Fetch images from i.js JSON endpoint
    const searchUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(
      q
    )}&vqd=${vqd}&f=,,,&p=1`;

    const data = await fetchJson(searchUrl, {
      Referer: "https://duckduckgo.com/",
      Accept: "application/json"
    });

    if (!data || !Array.isArray(data.results)) {
      return [];
    }

    return data.results.slice(0, 30).map((item) => {
      let domain = item.source || "";
      if (!domain && item.url) {
        try {
          domain = new URL(item.url).hostname;
        } catch (_) {}
      }
      return {
        title: decodeHtmlEntities(item.title) || "Medical diagram",
        imageUrl: item.image,
        thumbnailUrl: item.thumbnail || item.image,
        sourceUrl: item.url || item.image,
        width: item.width || null,
        height: item.height || null,
        domain: domain.replace(/^www\./, "")
      };
    });
  }

  async searchFallback(q) {
    // Basic fallback using Wikipedia / Wikimedia search if DDG token blocked
    const wikiProvider = new WikimediaProvider();
    return await wikiProvider.search(q);
  }
}

// 2. Wikimedia Commons Provider (Free, open medical and anatomical diagrams)
class WikimediaProvider {
  name = "Wikimedia Commons (Free)";

  async search(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      q
    )}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|extmetadata&format=json&origin=*`;

    const data = await fetchJson(url);
    if (!data || !data.query || !data.query.pages) return [];

    const pages = Object.values(data.query.pages);
    return pages
      .filter((p) => p.imageinfo && p.imageinfo.length > 0)
      .slice(0, 25)
      .map((p) => {
        const info = p.imageinfo[0];
        const title = decodeHtmlEntities(
          (p.title || "").replace(/^File:/, "").replace(/\.[^.]+$/, "")
        );
        const meta = info.extmetadata || {};
        const license = meta.LicenseShortName
          ? meta.LicenseShortName.value
          : "Wikimedia Commons";

        return {
          title: title || "Wikimedia medical illustration",
          imageUrl: info.url,
          thumbnailUrl: info.thumburl || info.url,
          sourceUrl: info.descriptionurl || info.url,
          width: info.width || null,
          height: info.height || null,
          domain: "commons.wikimedia.org",
          license
        };
      });
  }
}

// 3. Google Custom Search Engine (CSE API key + CX, 100 free queries/day)
class GoogleCseProvider {
  name = "Google Images (Custom Search API)";

  constructor(apiKey, cx) {
    this.apiKey = (apiKey || "").trim();
    this.cx = (cx || "").trim();
  }

  async search(query) {
    if (!this.apiKey || !this.cx) {
      throw new Error(
        "Google Custom Search requires both an API Key and Search Engine ID (CX). Please set them in plugin settings."
      );
    }
    const q = query.trim();
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
      this.apiKey
    )}&cx=${encodeURIComponent(
      this.cx
    )}&searchType=image&q=${encodeURIComponent(q)}&num=10`;

    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.items)) return [];

    return data.items.map((item) => ({
      title: decodeHtmlEntities(item.title) || "Google Image result",
      imageUrl: item.link,
      thumbnailUrl: item.image?.thumbnailLink || item.link,
      sourceUrl: item.image?.contextLink || item.link,
      width: item.image?.width || null,
      height: item.image?.height || null,
      domain: (item.displayLink || "").replace(/^www\./, "")
    }));
  }
}

// 4. SerpApi Provider (Google Images via SerpApi)
class SerpApiProvider {
  name = "Google Images via SerpApi";

  constructor(apiKey) {
    this.apiKey = (apiKey || "").trim();
  }

  async search(query) {
    if (!this.apiKey) {
      throw new Error(
        "SerpApi requires an API Key. Please enter it in plugin settings."
      );
    }
    const q = query.trim();
    const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(
      q
    )}&api_key=${encodeURIComponent(this.apiKey)}&hl=en`;

    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.images_results)) return [];

    return data.images_results.slice(0, 24).map((item) => ({
      title: decodeHtmlEntities(item.title) || "Google Image result",
      imageUrl: item.original,
      thumbnailUrl: item.thumbnail || item.original,
      sourceUrl: item.link || item.original,
      width: item.original_width || null,
      height: item.original_height || null,
      domain: (item.source || "").replace(/^www\./, "")
    }));
  }
}

// 5. Brave Search Provider
class BraveProvider {
  name = "Brave Images";

  constructor(apiKey) {
    this.apiKey = (apiKey || "").trim();
  }

  async search(query) {
    if (!this.apiKey) {
      throw new Error(
        "Brave Image Search requires an API Key. Please enter it in plugin settings."
      );
    }
    const q = query.trim();
    const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(
      q
    )}&count=24&search_lang=en&country=ALL&spellcheck=false&safesearch=off`;

    const data = await fetchJson(url, {
      "X-Subscription-Token": this.apiKey
    });

    if (!data || !Array.isArray(data.results)) return [];

    return data.results.slice(0, 24).map((item) => {
      let domain = "";
      try {
        domain = new URL(item.url).hostname;
      } catch (_) {}
      return {
        title: decodeHtmlEntities(item.title) || "Brave Image result",
        imageUrl: item.properties?.url,
        thumbnailUrl: item.thumbnail?.src || item.properties?.url,
        sourceUrl: item.url,
        width: item.properties?.width || null,
        height: item.properties?.height || null,
        domain: domain.replace(/^www\./, "")
      };
    });
  }
}

// -------------------------------------------------------------
// Image Preview Modal
// -------------------------------------------------------------
class ImagePreviewModal extends Modal {
  constructor(app, plugin, item) {
    super(app);
    this.plugin = plugin;
    this.item = item;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mif-preview-modal");

    this.titleEl.setText(this.item.title);

    const imgContainer = contentEl.createDiv({
      cls: "mif-modal-img-container"
    });
    const img = imgContainer.createEl("img", {
      cls: "mif-modal-img",
      attr: {
        src: this.item.imageUrl || this.item.thumbnailUrl,
        alt: this.item.title
      }
    });

    // Fallback if main image fails
    img.onerror = () => {
      if (this.item.thumbnailUrl && img.src !== this.item.thumbnailUrl) {
        img.src = this.item.thumbnailUrl;
      }
    };

    const details = contentEl.createDiv({ cls: "mif-card-meta" });
    if (this.item.width && this.item.height) {
      details.createSpan({
        text: `${this.item.width} × ${this.item.height} px`,
        cls: "mif-badge"
      });
    }
    if (this.item.domain) {
      details.createSpan({
        text: `Source: ${this.item.domain}`,
        cls: "mif-domain"
      });
    }

    const actions = contentEl.createDiv({ cls: "mif-modal-actions" });

    const copyBtn = actions.createEl("button", {
      text: "📋 Copy image to clipboard",
      cls: "mif-btn mif-btn-copy"
    });
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      copyBtn.setText("Copying...");
      try {
        await this.plugin.copyImageToClipboard(this.item);
        this.close();
      } catch (err) {
        new Notice(`Failed to copy: ${err.message}`);
      } finally {
        copyBtn.disabled = false;
        copyBtn.setText("📋 Copy image to clipboard");
      }
    };

    const insertBtn = actions.createEl("button", {
      text: "📥 Save & insert into note",
      cls: "mif-btn mif-btn-insert"
    });
    insertBtn.onclick = async () => {
      insertBtn.disabled = true;
      insertBtn.setText("Inserting...");
      try {
        await this.plugin.saveAndInsertImage(this.item);
        this.close();
      } catch (err) {
        new Notice(`Failed to insert: ${err.message}`);
      } finally {
        insertBtn.disabled = false;
        insertBtn.setText("📥 Save & insert into note");
      }
    };

    const openSourceBtn = actions.createEl("button", {
      text: "🌐 Open source page",
      cls: "mif-btn"
    });
    openSourceBtn.onclick = () => {
      if (this.item.sourceUrl) {
        electron.shell.openExternal(this.item.sourceUrl);
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// Sidebar View
// -------------------------------------------------------------
class MedicalImageFinderView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.results = [];
    this.isSearching = false;
    this.statusMessage = "";
    this.statusType = "normal"; // normal, loading, error
    this.activeFilter = this.plugin.settings.defaultFilterMode || "all";
  }

  getViewType() {
    return VIEW_TYPE_MIF;
  }

  getDisplayText() {
    return "Medical Image Finder";
  }

  getIcon() {
    return "image";
  }

  async onOpen() {
    this.render();
  }

  setQuery(query, autoSearch = true) {
    this.currentQuery = query;
    if (this.queryInput) {
      this.queryInput.value = query;
    }
    this.render();
    if (autoSearch && query.trim()) {
      this.executeSearch(query.trim());
    }
  }

  getEffectiveQuery(baseQuery, filterId) {
    const clean = cleanText(baseQuery);
    if (!clean) return "";
    const filter = MEDICAL_VISUAL_FILTERS.find((f) => f.id === filterId);
    if (!filter || !filter.modifier) return clean;
    const words = filter.modifier.split(" ");
    const needed = words.filter(
      (w) => !clean.toLowerCase().includes(w.toLowerCase())
    );
    return needed.length > 0 ? `${clean} ${needed.join(" ")}` : clean;
  }

  async executeSearch(query) {
    if (!query || !query.trim()) return;
    this.isSearching = true;
    this.statusType = "loading";
    const provider = this.plugin.getActiveProvider();
    const effectiveQuery = this.getEffectiveQuery(query, this.activeFilter);
    const filterObj = MEDICAL_VISUAL_FILTERS.find(
      (f) => f.id === this.activeFilter
    );
    const filterTag =
      filterObj && filterObj.id !== "all" ? ` [${filterObj.label}]` : "";
    this.statusMessage = `Searching for "${query}"${filterTag} via ${provider.name}...`;
    this.render();

    try {
      this.results = await provider.search(effectiveQuery);
      this.isSearching = false;
      this.statusType = "normal";
      this.statusMessage =
        this.results.length > 0
          ? `Found ${this.results.length} images${filterTag}.`
          : `No images found for this query${filterTag}. Try another filter or search term.`;
    } catch (err) {
      this.isSearching = false;
      this.statusType = "error";
      this.statusMessage = `Error: ${err.message || err}`;
      this.results = [];
    }
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("mif-container");

    // Header section
    const header = root.createDiv({ cls: "mif-header" });
    header.createDiv({
      text: "MEDICINE & SURGERY ATLAS",
      cls: "mif-kicker"
    });

    const titleRow = header.createDiv({ cls: "mif-title-row" });
    titleRow.createEl("h3", {
      text: "Medical Image Finder",
      cls: "mif-title"
    });

    // Active note indicator
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (activeFile) {
      header.createDiv({
        text: `Target: ${activeFile.basename}`,
        cls: "mif-target-note"
      });
    }

    // Search input row
    const form = header.createDiv({ cls: "mif-search-form" });
    const queryWrapper = form.createDiv({ cls: "mif-query-wrapper" });

    this.queryInput = queryWrapper.createEl("input", {
      cls: "mif-query-input",
      attr: {
        type: "text",
        placeholder: "e.g. triangle of doom borders...",
        value: this.currentQuery || ""
      }
    });

    this.queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = this.queryInput.value.trim();
        if (val) this.executeSearch(val);
      }
    });

    const searchBtn = queryWrapper.createEl("button", {
      text: "Search",
      cls: "mif-btn mif-btn-copy"
    });
    searchBtn.onclick = () => {
      const val = this.queryInput.value.trim();
      if (val) this.executeSearch(val);
    };

    // Provider selection row
    const providerRow = form.createDiv({ cls: "mif-provider-row" });
    providerRow.createSpan({ text: "Source engine:" });

    const select = providerRow.createEl("select", {
      cls: "mif-provider-select"
    });
    const options = [
      { id: "duckduckgo", label: "DuckDuckGo (Free / No Key)" },
      { id: "wikimedia", label: "Wikimedia Commons (Free)" },
      { id: "google_cse", label: "Google Custom Search (CSE API)" },
      { id: "serpapi", label: "Google Images (SerpApi)" },
      { id: "brave", label: "Brave Search API" }
    ];

    options.forEach((opt) => {
      const el = select.createEl("option", { text: opt.label, value: opt.id });
      if (opt.id === this.plugin.settings.defaultProvider) {
        el.selected = true;
      }
    });

    select.onchange = async () => {
      this.plugin.settings.defaultProvider = select.value;
      await this.plugin.saveSettings();
      const val = this.queryInput.value.trim();
      if (val) {
        this.executeSearch(val);
      }
    };

    // Medical Visual Mode Filter Bar
    const filterBar = form.createDiv({ cls: "mif-filter-bar" });
    MEDICAL_VISUAL_FILTERS.forEach((filter) => {
      const pill = filterBar.createEl("button", {
        text: filter.label,
        cls: `mif-filter-pill ${
          this.activeFilter === filter.id ? "is-active" : ""
        }`
      });
      pill.type = "button";
      pill.onclick = () => {
        if (this.activeFilter === filter.id) return;
        this.activeFilter = filter.id;
        this.render();
        const val = this.queryInput
          ? this.queryInput.value.trim()
          : (this.currentQuery || "").trim();
        if (val) {
          this.executeSearch(val);
        }
      };
    });

    // Status message
    if (this.statusMessage) {
      const statusEl = root.createDiv({
        cls: `mif-status ${
          this.statusType === "loading"
            ? "is-loading"
            : this.statusType === "error"
            ? "is-error"
            : ""
        }`,
        text: this.statusMessage
      });
    }

    // Results List
    if (this.results.length === 0 && !this.isSearching) {
      const emptyState = root.createDiv({ cls: "mif-empty-state" });
      emptyState.createDiv({ text: "🩺", cls: "mif-empty-icon" });
      emptyState.createEl("h3", {
        text: "Search Medical & Surgical Images"
      });
      emptyState.createEl("p", {
        text: "Select any medical terminology in your note and run 'Find images' or type a query above."
      });
      return;
    }

    const list = root.createDiv({ cls: "mif-results-list" });

    this.results.forEach((item) => {
      const card = list.createDiv({ cls: "mif-card" });

      // Thumbnail
      const thumbContainer = card.createDiv({
        cls: "mif-thumb-container"
      });
      const img = thumbContainer.createEl("img", {
        cls: "mif-thumb",
        attr: {
          src: item.thumbnailUrl || item.imageUrl,
          alt: item.title,
          loading: "lazy"
        }
      });

      // Overlay dimension tag
      if (item.width && item.height) {
        thumbContainer.createDiv({
          text: `${item.width}×${item.height}`,
          cls: "mif-thumb-overlay"
        });
      }

      thumbContainer.onclick = () => {
        new ImagePreviewModal(this.app, this.plugin, item).open();
      };

      // Card Body
      const body = card.createDiv({ cls: "mif-card-body" });
      body.createEl("h4", { text: item.title, cls: "mif-card-title" });

      const meta = body.createDiv({ cls: "mif-card-meta" });
      if (item.domain) {
        meta.createSpan({ text: item.domain, cls: "mif-domain" });
      }

      // Actions Toolbar
      const actions = body.createDiv({ cls: "mif-card-actions" });

      // 1. Prominent Copy Image Button
      const copyBtn = actions.createEl("button", {
        text: "📋 Copy image",
        cls: "mif-btn mif-btn-copy"
      });
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        copyBtn.disabled = true;
        copyBtn.setText("Copying...");
        try {
          await this.plugin.copyImageToClipboard(item);
        } catch (err) {
          new Notice(`Copy failed: ${err.message}`);
        } finally {
          copyBtn.disabled = false;
          copyBtn.setText("📋 Copy image");
        }
      };

      // 2. Insert Beside Selection Button
      const insertBtn = actions.createEl("button", {
        text: "📥 Insert in note",
        cls: "mif-btn mif-btn-insert"
      });
      insertBtn.onclick = async (e) => {
        e.stopPropagation();
        insertBtn.disabled = true;
        insertBtn.setText("Inserting...");
        try {
          await this.plugin.saveAndInsertImage(item);
        } catch (err) {
          new Notice(`Insert failed: ${err.message}`);
        } finally {
          insertBtn.disabled = false;
          insertBtn.setText("📥 Insert in note");
        }
      };

      // Sub-actions: Preview and Source
      const subActions = body.createDiv({ cls: "mif-sub-actions" });

      const previewLink = subActions.createEl("button", {
        text: "🔍 Preview full size",
        cls: "mif-link-btn"
      });
      previewLink.onclick = () => {
        new ImagePreviewModal(this.app, this.plugin, item).open();
      };

      if (item.sourceUrl) {
        const sourceLink = subActions.createEl("button", {
          text: "🌐 Source ↗",
          cls: "mif-link-btn"
        });
        sourceLink.onclick = () => {
          electron.shell.openExternal(item.sourceUrl);
        };
      }
    });
  }
}

// -------------------------------------------------------------
// Settings Tab
// -------------------------------------------------------------
class MedicalImageFinderSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Medical Image Finder Settings" });

    new Setting(containerEl)
      .setName("Default Search Engine")
      .setDesc("Choose which image search engine to use by default.")
      .addDropdown((drop) => {
        drop
          .addOption("duckduckgo", "DuckDuckGo (Free / No Key)")
          .addOption("wikimedia", "Wikimedia Commons (Free)")
          .addOption("google_cse", "Google Custom Search (CSE API)")
          .addOption("serpapi", "Google Images (SerpApi)")
          .addOption("brave", "Brave Search API")
          .setValue(this.plugin.settings.defaultProvider)
          .onChange(async (val) => {
            this.plugin.settings.defaultProvider = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Default Visual Mode Filter")
      .setDesc("Choose the default visual filter mode for searches.")
      .addDropdown((drop) => {
        MEDICAL_VISUAL_FILTERS.forEach((f) => {
          drop.addOption(f.id, f.label);
        });
        drop
          .setValue(this.plugin.settings.defaultFilterMode || "all")
          .onChange(async (val) => {
            this.plugin.settings.defaultFilterMode = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Attachment Folder")
      .setDesc(
        "Vault directory where downloaded images are permanently stored."
      )
      .addText((text) => {
        text
          .setPlaceholder("Attachments/MedicalImages")
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (val) => {
            this.plugin.settings.attachmentFolder =
              val.trim() || "Attachments/MedicalImages";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Default Embedded Image Width (px)")
      .setDesc("Markdown image display width (e.g. 500 for ![[image.png|500]]).")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.defaultImageWidth))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num > 50) {
              this.plugin.settings.defaultImageWidth = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Include Source Attribution Caption")
      .setDesc(
        "Append a clean source caption link beneath the inserted image."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeCaption)
          .onChange(async (val) => {
            this.plugin.settings.includeCaption = val;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Google Custom Search API (Optional)" });
    containerEl.createEl("p", {
      text: "Free 100 queries/day from Google Cloud Console + Programmable Search Engine.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Google Cloud API Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.googleApiKey)
          .onChange(async (val) => {
            this.plugin.settings.googleApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Google Search Engine ID (CX)")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.googleCx)
          .onChange(async (val) => {
            this.plugin.settings.googleCx = val.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "SerpApi Google Images (Optional)" });

    new Setting(containerEl)
      .setName("SerpApi API Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.serpApiKey)
          .onChange(async (val) => {
            this.plugin.settings.serpApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Brave Search API (Optional)" });

    new Setting(containerEl)
      .setName("Brave API Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.braveApiKey)
          .onChange(async (val) => {
            this.plugin.settings.braveApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });
  }
}

// -------------------------------------------------------------
// Main Plugin Class
// -------------------------------------------------------------
class MedicalImageFinderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Register sidebar view
    this.registerView(
      VIEW_TYPE_MIF,
      (leaf) => new MedicalImageFinderView(leaf, this)
    );

    // Ribbon icon
    this.addRibbonIcon("image", "Medical Image Finder", () => {
      this.activateView();
    });

    // Primary command: Find images for selection / cursor
    this.addCommand({
      id: "find-images",
      name: "Find images",
      editorCallback: (editor, view) => {
        this.triggerSearchFromEditor(editor, view);
      }
    });

    // Sidebar command: Open search sidebar
    this.addCommand({
      id: "open-sidebar",
      name: "Open image search sidebar",
      callback: () => {
        this.activateView();
      }
    });

    // Register Editor Context Menu item
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          const shortText =
            selection.length > 30 ? selection.slice(0, 30) + "..." : selection;
          menu.addItem((item) => {
            item
              .setTitle(`Find images for "${shortText}"`)
              .setIcon("image")
              .onClick(() => {
                this.triggerSearchFromEditor(editor, view);
              });
          });
        }
      })
    );

    // Settings Tab
    this.addSettingTab(new MedicalImageFinderSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MIF);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getActiveProvider() {
    switch (this.settings.defaultProvider) {
      case "wikimedia":
        return new WikimediaProvider();
      case "google_cse":
        return new GoogleCseProvider(
          this.settings.googleApiKey,
          this.settings.googleCx
        );
      case "serpapi":
        return new SerpApiProvider(this.settings.serpApiKey);
      case "brave":
        return new BraveProvider(this.settings.braveApiKey);
      case "duckduckgo":
      default:
        return new DuckDuckGoProvider();
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MIF)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      await rightLeaf.setViewState({
        type: VIEW_TYPE_MIF,
        active: true
      });
      leaf = rightLeaf;
    }

    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async triggerSearchFromEditor(editor, view) {
    let query = editor.getSelection().trim();

    if (!query) {
      // If no text is selected, fallback to current line
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line).trim();
      query = cleanText(line);
    }

    if (!query) {
      new Notice("Select medical terminology in your note first.");
      await this.activateView();
      return;
    }

    const leafView = await this.activateView();
    if (leafView && typeof leafView.setQuery === "function") {
      leafView.setQuery(query, true);
    }
  }

  // Copy Image directly to Windows / system clipboard
  async copyImageToClipboard(item) {
    let buffer = null;
    let targetUrl = item.imageUrl || item.thumbnailUrl;

    try {
      buffer = await fetchBinary(targetUrl);
    } catch (err) {
      if (item.thumbnailUrl && item.thumbnailUrl !== targetUrl) {
        targetUrl = item.thumbnailUrl;
        buffer = await fetchBinary(targetUrl);
      } else {
        throw err;
      }
    }

    const uint8 = new Uint8Array(buffer);
    const nodeBuf = Buffer.from(uint8);

    // Try Electron nativeImage createFromBuffer
    let nativeImg = electron.nativeImage.createFromBuffer(nodeBuf);

    if (nativeImg.isEmpty()) {
      // Decode via Image element and canvas in browser context
      nativeImg = await this.decodeViaCanvas(nodeBuf);
    }

    electron.clipboard.writeImage(nativeImg);
    new Notice("Image copied to clipboard! Press Ctrl+V in your note to paste.", 5000);
  }

  async decodeViaCanvas(nodeBuf) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([nodeBuf]);
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => {
          b.arrayBuffer()
            .then((ab) => {
              URL.revokeObjectURL(blobUrl);
              const resultImg = electron.nativeImage.createFromBuffer(
                Buffer.from(ab)
              );
              resolve(resultImg);
            })
            .catch(reject);
        }, "image/png");
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error("Image decoding failed"));
      };
      img.src = blobUrl;
    });
  }

  // Save image binary to vault attachments folder and insert into active note
  async saveAndInsertImage(item) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      throw new Error("Please open or focus the target Markdown note first.");
    }

    const editor = activeView.editor;
    const file = activeView.file;

    // Download image data
    let buffer = null;
    let targetUrl = item.imageUrl || item.thumbnailUrl;

    try {
      buffer = await fetchBinary(targetUrl);
    } catch (err) {
      if (item.thumbnailUrl && item.thumbnailUrl !== targetUrl) {
        targetUrl = item.thumbnailUrl;
        buffer = await fetchBinary(targetUrl);
      } else {
        throw err;
      }
    }

    // Determine extension
    const uint8 = new Uint8Array(buffer);
    let ext = "png";
    if (uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) {
      ext = "jpg";
    } else if (
      uint8[0] === 0x89 &&
      uint8[1] === 0x50 &&
      uint8[2] === 0x4e &&
      uint8[3] === 0x47
    ) {
      ext = "png";
    } else if (
      uint8[0] === 0x52 &&
      uint8[1] === 0x49 &&
      uint8[2] === 0x46 &&
      uint8[3] === 0x46
    ) {
      ext = "webp";
    }

    // Generate unique filename with hash
    const hash = crypto
      .createHash("sha256")
      .update(Buffer.from(uint8))
      .digest("hex")
      .slice(0, 8);
    const sanitizedTitle = safeFileName(item.title);
    const fileName = `${sanitizedTitle}-${hash}.${ext}`;

    const folderPath = normalizePath(
      this.settings.attachmentFolder || "Attachments/MedicalImages"
    );

    // Ensure folder exists
    await this.ensureFolder(folderPath);

    const fullPath = `${folderPath}/${fileName}`;
    const existing = this.app.vault.getAbstractFileByPath(fullPath);

    if (!existing) {
      await this.app.vault.createBinary(fullPath, buffer);
    }

    // Determine insertion position in note:
    // Insert immediately below the selected sentence/paragraph
    const width = this.settings.defaultImageWidth || 500;
    let embedMarkdown = `\n\n![[${fullPath}|${width}]]`;
    if (this.settings.includeCaption) {
      const captionTitle = cleanText(item.title) || "Medical reference";
      const sourceLine = item.sourceUrl
        ? `[${item.domain || "Source"}](<${item.sourceUrl}>)`
        : item.domain || "";
      embedMarkdown += `\n*${captionTitle}* — ${sourceLine}\n`;
    } else {
      embedMarkdown += `\n`;
    }

    // Calculate position: right below current selection or cursor line
    const selFrom = editor.getCursor("from");
    const selTo = editor.getCursor("to");
    const targetLine = selTo.line;
    const lineContent = editor.getLine(targetLine);
    const lineEndPos = { line: targetLine, ch: lineContent.length };

    editor.replaceRange(embedMarkdown, lineEndPos);

    new Notice(`Saved to ${fileName} and inserted beside explanation!`, 5000);
  }

  async ensureFolder(folderPath) {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const file = this.app.vault.getAbstractFileByPath(current);
      if (!file) {
        try {
          await this.app.vault.createFolder(current);
        } catch (_) {}
      }
    }
  }
}

module.exports = MedicalImageFinderPlugin;
