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
  includeCaption: false,
  googleApiKey: "",
  googleCx: "",
  serpApiKey: "",
  braveApiKey: "",
  brightDataApiKey: "",
  brightDataZone: "serp_api1",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiMaxSuggestions: 25,
  geminiCustomModels: [],
  aiBackend: "gemini",
  groqApiKey: "",
  groqModel: "llama-3.1-8b-instant",
  openAiBaseUrl: "https://openrouter.ai/api/v1",
  openAiApiKey: "",
  openAiModel: "meta-llama/llama-3.3-70b-instruct:free",
  lastImportedGeminiResponse: "",
  lastScanResults: null,
  lastScannedNote: ""
};

// Medical Visual Mode Quick-Filters
const MEDICAL_VISUAL_FILTERS = [
  { id: "all",       label: "All",               modifier: "" },
  { id: "diagram",   label: "Anatomy / Diagram",  modifier: "labeled anatomical diagram cross-section" },
  { id: "radiology", label: "Radiology",           modifier: "radiology CT MRI X-ray pathognomonic sign" },
  { id: "histology", label: "HPE / Histology",     modifier: "histopathology H&E microscopy slide" },
  { id: "clinical",  label: "Clinical / Surgical", modifier: "clinical operative surgical view" },
  { id: "criteria",  label: "Criteria / Scoring",  modifier: "diagnostic criteria scoring system flowchart table" },
  { id: "embryology",label: "Embryology / Physio", modifier: "embryology development physiology flowchart" }
];



async function copyToClipboard(str) {
  try {
    if (electron && electron.clipboard && typeof electron.clipboard.writeText === "function") {
      electron.clipboard.writeText(str);
      return true;
    }
  } catch (_) {}
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch (_) {}
  return false;
}

async function readFromClipboard() {
  try {
    if (electron && electron.clipboard && typeof electron.clipboard.readText === "function") {
      const txt = electron.clipboard.readText();
      if (txt) return txt;
    }
  } catch (_) {}
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      return await navigator.clipboard.readText();
    }
  } catch (_) {}
  return "";
}

class SearchCache {
  constructor(maxSize = 100, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    if (!key) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return Array.isArray(entry.value) ? entry.value.map(item => ({ ...item })) : entry.value;
  }

  set(key, value) {
    if (!key || !Array.isArray(value) || value.length === 0) return;
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now > v.expiry) this.cache.delete(k);
      }
      if (this.cache.size >= this.maxSize) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value: value.map(item => ({ ...item })), expiry: Date.now() + this.ttlMs });
  }

  clear() {
    this.cache.clear();
  }
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

function openExternalUrl(value) {
  const clean = httpUrl(value);
  if (!clean) return false;
  try {
    if (typeof electron !== 'undefined' && electron?.shell?.openExternal) {
      electron.shell.openExternal(clean);
      return true;
    }
  } catch (_) {}
  try {
    if (typeof window !== 'undefined' && window.open) {
      window.open(clean, '_blank');
      return true;
    }
  } catch (_) {}
  return false;
}

const knownSecrets = new Set();
function rememberSecrets(settings) {
  for (const key of ['googleApiKey', 'serpApiKey', 'braveApiKey', 'brightDataApiKey', 'geminiApiKey', 'groqApiKey', 'openAiApiKey']) {
    if (typeof settings[key] === 'string' && settings[key].trim()) knownSecrets.add(settings[key].trim());
  }
}

function safeError(error) {
  let message = String(error?.message || error || 'Unknown error');
  for (const secret of knownSecrets) message = message.split(secret).join('[redacted]');
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, '[request URL]')
    .replace(/((?:api[_-]?key|key|token)\s*[=:]\s*)[^\s&,]+/gi, '$1[redacted]')
    .replace(/AIza[\w-]+/g, '[redacted]');
}

function attachmentPath(value) {
  const path = String(value || DEFAULT_SETTINGS.attachmentFolder).trim().replace(/\\/g, '/');
  if (path.startsWith('/') || /[:<>"|?*\x00-\x1f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Attachment folder must be a valid relative vault folder.');
  }
  return normalizePath(path);
}

function normalizeSettings(saved) {
  const settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!['duckduckgo', 'wikimedia', 'google_cse', 'serpapi', 'brave', 'brightdata'].includes(settings.defaultProvider)) settings.defaultProvider = 'duckduckgo';
  if (!MEDICAL_VISUAL_FILTERS.some(f => f.id === settings.defaultFilterMode)) settings.defaultFilterMode = 'all';
  if (!['gemini','groq','openrouter','offline'].includes(settings.aiBackend)) settings.aiBackend = 'gemini';
  if (typeof settings.groqApiKey !== 'string') settings.groqApiKey = '';
  if (typeof settings.openAiBaseUrl !== 'string') settings.openAiBaseUrl = 'https://openrouter.ai/api/v1';
  if (typeof settings.openAiApiKey !== 'string') settings.openAiApiKey = '';
  if (typeof settings.openAiModel !== 'string') settings.openAiModel = 'meta-llama/llama-3.3-70b-instruct:free';
  const DECOMMISSIONED_GROQ = ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it', 'llama-3.1-70b-versatile'];
  if (typeof settings.groqModel !== 'string' || !settings.groqModel || DECOMMISSIONED_GROQ.includes(settings.groqModel)) {
    settings.groqModel = 'llama-3.1-8b-instant';
  }
  for (const key of ['googleApiKey','googleCx','serpApiKey','braveApiKey','brightDataApiKey','brightDataZone','geminiApiKey','geminiModel']) {
    settings[key] = typeof settings[key] === 'string' ? settings[key].trim() : DEFAULT_SETTINGS[key];
  }
  if (!settings.geminiModel) settings.geminiModel = DEFAULT_SETTINGS.geminiModel;
  if (!Number.isInteger(settings.defaultImageWidth) || settings.defaultImageWidth <= 50) settings.defaultImageWidth = 500;
  if (!Number.isInteger(settings.geminiMaxSuggestions) || settings.geminiMaxSuggestions < 5 || settings.geminiMaxSuggestions > 50) settings.geminiMaxSuggestions = 25;
  if (typeof settings.includeCaption !== 'boolean') settings.includeCaption = false;
  settings.geminiCustomModels = Array.isArray(settings.geminiCustomModels) ? settings.geminiCustomModels.filter(m => m && typeof m.id === 'string' && typeof m.label === 'string') : [];
  settings.lastImportedGeminiResponse = typeof settings.lastImportedGeminiResponse === 'string' ? settings.lastImportedGeminiResponse : '';
  settings.lastScanResults = (settings.lastScanResults && typeof settings.lastScanResults === 'object' && Array.isArray(settings.lastScanResults.suggestions)) ? settings.lastScanResults : null;
  settings.lastScannedNote = typeof settings.lastScannedNote === 'string' ? settings.lastScannedNote : '';
  try { settings.attachmentFolder = attachmentPath(settings.attachmentFolder); }
  catch (_) { settings.attachmentFolder = DEFAULT_SETTINGS.attachmentFolder; }
  return settings;
}

function isImageUri(u) {
  return typeof u === 'string' && (Boolean(httpUrl(u)) || u.startsWith('data:image/'));
}

function normalizeResults(items) {
  if (!Array.isArray(items)) throw new Error('Unexpected image search response.');
  return items.filter(item => item && (isImageUri(item.imageUrl) || isImageUri(item.thumbnailUrl))).map(item => {
    const validImg = httpUrl(item.imageUrl) || (typeof item.imageUrl === 'string' && item.imageUrl.startsWith('data:image/') ? item.imageUrl : '');
    const validThumb = httpUrl(item.thumbnailUrl) || (typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.startsWith('data:image/') ? item.thumbnailUrl : '');
    return {
      ...item,
      title: typeof item.title === 'string' ? item.title : 'Medical image',
      imageUrl: validImg || validThumb,
      thumbnailUrl: validThumb || validImg,
      sourceUrl: httpUrl(item.sourceUrl),
      domain: typeof item.domain === 'string' ? item.domain : ''
    };
  });
}

function markdownText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>!|]/g, '\\$&');
}

function imageExtension(bytes) {
  const head = Buffer.from(bytes).subarray(0, 16);
  if (head.length >= 8 && head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'jpg';
  if (/^GIF8[79]a/.test(head.toString('ascii'))) return 'gif';
  if (head.toString('ascii',0,4) === 'RIFF' && head.toString('ascii',8,12) === 'WEBP') return 'webp';
  return null;
}

// Utilities
function cleanText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
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
  if (typeof str !== "string") return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#0*39|#x0*27|apos);/gi, "'")
    .replace(/&(?:#0*34|#x0*22);/gi, '"')
    .replace(/&(?:#0*38|#x0*26);/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&(?:#0*8211|ndash);/gi, "–")
    .replace(/&(?:#0*8212|mdash);/gi, "—")
    .replace(/&(?:#0*8216|#0*8217|lsquo|rsquo);/gi, "'")
    .replace(/&(?:#0*8220|#0*8221|ldquo|rdquo);/gi, '"')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        return (code > 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : "";
      } catch (_) { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        return (code > 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : "";
      } catch (_) { return ""; }
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Network requests through Obsidian; report sanitized failures.
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
    throw new Error(`Page request failed: ${safeError(err)}`);
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
    const data = res.json;
    if (!data || typeof data !== 'object') throw new Error('Unexpected API response.');
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message || 'Provider rejected request.');
    return data;
  } catch (err) {
    throw new Error(`API request failed: ${safeError(err)}`);
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
    if (!res.arrayBuffer || !res.arrayBuffer.byteLength) throw new Error('Empty image response.');
    return res.arrayBuffer;
  } catch (err) {
    throw new Error(`Failed to download image: ${safeError(err)}`);
  }
}

// -------------------------------------------------------------
// Search Providers
// -------------------------------------------------------------

// 1. DuckDuckGo Image Provider (Zero API Key, free, high quality)
class DuckDuckGoProvider {
  name = "DuckDuckGo (Free / No Key)";

  async search(query) {
    this.name = "DuckDuckGo (Free / No Key)";
    try { return await this.searchPrimary(query); }
    catch (_) { return this.searchFallback(query); }
  }

  async searchPrimary(query) {
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
      html.match(/vqd:\s*['"]([^'"]+)['"]/) ||
      html.match(/["']vqd["']\s*:\s*["']([^"']+)["']/i) ||
      html.match(/[?&]vqd=([a-zA-Z0-9_-]+)/i);

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
      throw new Error("Unexpected DuckDuckGo response.");
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
    this.name = "Wikimedia Commons (DuckDuckGo fallback)";
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
    )}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|extmetadata|mime&iiurlwidth=600&format=json&origin=*`;

    const data = await fetchJson(url);
    if (data?.batchcomplete !== undefined && !data.query) return [];
    if (!data?.query?.pages) throw new Error('Unexpected Wikimedia response.');

    const pages = Object.values(data.query.pages);
    return pages
      .filter((p) => p.imageinfo?.[0]?.mime?.startsWith("image/"))
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
    if (!Array.isArray(data.items)) {
      if (String(data.searchInformation?.totalResults) === '0') return [];
      throw new Error('Unexpected Google response.');
    }

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
    if (!Array.isArray(data.images_results)) throw new Error("Unexpected SerpApi response.");

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

    if (!Array.isArray(data.results)) throw new Error("Unexpected Brave response.");

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

// 6. Bright Data Provider (Google Images via Bright Data SERP & Scraper API)
class BrightDataProvider {
  name = "Google Images via Bright Data";

  constructor(apiKey, zone = "serp_api1") {
    this.apiKey = (apiKey || "").trim();
    this.zone = (zone || "serp_api1").trim();
  }

  async search(query) {
    if (!this.apiKey) {
      throw new Error(
        "Bright Data requires an API Key. Please enter it in plugin settings (Free 5,000 records/month)."
      );
    }
    const q = query.trim();
    const targetUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=isch&udm=2`;

    // 1. Try Fast SERP API endpoint
    try {
      const resp = await requestUrl({
        url: "https://api.brightdata.com/request",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          zone: this.zone || "serp_api1",
          url: targetUrl,
          format: "json"
        })
      });

      if (resp.status === 200) {
        let data = typeof resp.json === "object" && resp.json !== null ? resp.json : null;
        if (!data && typeof resp.text === "string") {
          try { data = JSON.parse(resp.text); } catch (_) {}
        }

        // Unwrap envelope if Bright Data returned { status_code: 200, headers: {...}, body: "..." }
        let rawBodyString = "";
        if (data && data.body) {
          if (typeof data.body === "string") {
            rawBodyString = data.body;
            try { data = JSON.parse(data.body); } catch (_) {}
          } else if (typeof data.body === "object" && data.body !== null) {
            data = data.body;
          }
        }

        if (data && data.error) {
          throw new Error(`Bright Data error: ${data.error}`);
        }
        if (data && data.message && !data.images && !data.images_results && !data.organic) {
          throw new Error(`Bright Data message: ${data.message}`);
        }

        // Case A: data.images array (Standard Google Images SERP)
        if (data && Array.isArray(data.images) && data.images.length > 0) {
          return data.images.slice(0, 30).map((item) => {
            let domain = "";
            try {
              if (item.original_image) domain = new URL(item.original_image).hostname;
              else if (item.link) domain = new URL(item.link).hostname;
            } catch (_) {}
            if (domain.includes("google.") && item.title) {
              domain = item.title;
            } else if (!domain && item.title) {
              domain = item.title;
            }
            let title = decodeHtmlEntities(item.source || item.title) || q;
            if (item.title && typeof item.title === 'string' && title.endsWith(item.title + item.title)) {
              title = title.slice(0, -item.title.length);
            }
            return {
              title: title,
              imageUrl: item.original_image || item.image,
              thumbnailUrl: item.image || item.original_image,
              sourceUrl: item.original_image || item.link || targetUrl,
              width: item.original_width || item.image_width || null,
              height: item.original_height || item.image_height || null,
              domain: domain.replace(/^www\./, "")
            };
          });
        }

        // Case B: data.images_results array
        if (data && Array.isArray(data.images_results) && data.images_results.length > 0) {
          return data.images_results.slice(0, 30).map((item) => {
            let domain = "";
            try {
              if (item.original) domain = new URL(item.original).hostname;
              else if (item.link) domain = new URL(item.link).hostname;
            } catch (_) {}
            if (domain.includes("google.") && item.source) {
              domain = item.source;
            } else if (!domain && item.source) {
              domain = item.source;
            }
            return {
              title: decodeHtmlEntities(item.title) || q,
              imageUrl: item.original || item.thumbnail,
              thumbnailUrl: item.thumbnail || item.original,
              sourceUrl: item.original || item.link || targetUrl,
              width: item.original_width || null,
              height: item.original_height || null,
              domain: domain.replace(/^www\./, "")
            };
          });
        }

        // Case C: data.organic with images (if Light JSON was used)
        if (data && Array.isArray(data.organic) && data.organic.length > 0) {
          const organicWithImages = data.organic.filter(item => item.image || item.images);
          if (organicWithImages.length > 0) {
            return organicWithImages.slice(0, 30).map((item) => {
              let domain = "";
              try { if (item.link) domain = new URL(item.link).hostname; } catch (_) {}
              const imgUrl = item.image || (Array.isArray(item.images) ? item.images[0] : null);
              return {
                title: decodeHtmlEntities(item.title) || q,
                imageUrl: imgUrl,
                thumbnailUrl: imgUrl,
                sourceUrl: item.link || targetUrl,
                width: null,
                height: null,
                domain: domain.replace(/^www\./, "")
              };
            });
          }
        }

        // Case D: Top-level array
        if (Array.isArray(data) && data.length > 0) {
          return data.slice(0, 30).map((item) => {
            let domain = "";
            const src = item.original_image || item.image || item.image_url || item.url;
            try { if (item.link || item.url) domain = new URL(item.link || item.url).hostname; } catch (_) {}
            return {
              title: decodeHtmlEntities(item.title) || q,
              imageUrl: src,
              thumbnailUrl: item.image || item.thumbnail || src,
              sourceUrl: item.link || item.url || targetUrl,
              width: item.original_width || null,
              height: item.original_height || null,
              domain: domain.replace(/^www\./, "")
            };
          });
        }

        // Case E: Fallback extraction from raw HTML string if Bright Data returns HTML
        if (rawBodyString && (typeof rawBodyString === 'string' && rawBodyString.includes('<'))) {
          const foundImages = [];
          const seen = new Set();
          const re = /"(https?:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=[^"]+)"/g;
          let m;
          while ((m = re.exec(rawBodyString)) !== null && foundImages.length < 30) {
            const u = m[1].replace(/\\u0026/g, '&');
            if (!seen.has(u)) {
              seen.add(u);
              foundImages.push({
                title: q,
                imageUrl: u,
                thumbnailUrl: u,
                sourceUrl: targetUrl,
                width: null,
                height: null,
                domain: "google.com"
              });
            }
          }
          if (foundImages.length > 0) return foundImages;
        }

        // If parsed JSON has no images (e.g. Light JSON only returned organic text)
        if (data && typeof data === "object") {
          const keys = Object.keys(data).join(", ");
          throw new Error(`Bright Data returned [${keys}], but no image grid. In Bright Data dashboard → serp_api1 → Configuration → Data format, select 'Full JSON' and click Save changes.`);
        }
      }
    } catch (serpErr) {
      if (serpErr.message && (serpErr.message.includes("Full JSON") || serpErr.message.includes("API Key") || serpErr.message.includes("Bright Data error:"))) {
        throw serpErr;
      }
      // 2. Fallback to Dataset scraper API
      try {
        const dResp = await requestUrl({
          url: "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m0cda3zn1y9cr8l8yr&format=json",
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify([{ url: targetUrl }])
        });

        if (dResp.status === 200) {
          let list = Array.isArray(dResp.json) ? dResp.json : null;
          if (!list && typeof dResp.text === "string") {
            try { list = JSON.parse(dResp.text); } catch (_) {}
          }
          if (Array.isArray(list) && list.length > 0) {
            return list.slice(0, 24).map((item) => {
              let domain = "";
              try { if (item.url) domain = new URL(item.url).hostname; } catch (_) {}
              return {
                title: decodeHtmlEntities(item.title) || q,
                imageUrl: item.image_url || item.url,
                thumbnailUrl: item.image_url || item.url,
                sourceUrl: item.url || targetUrl,
                width: null,
                height: null,
                domain: domain.replace(/^www\./, "")
              };
            });
          }
        }
      } catch (_) {
        throw serpErr;
      }
      throw serpErr;
    }

    throw new Error("Unexpected Bright Data response format. In Bright Data dashboard → serp_api1 → Configuration → Data format, select 'Full JSON' and Save changes.");
  }
}

// -------------------------------------------------------------
// Offline Medical Heuristic Scanner (100% Offline & Foolproof)
// Zero API keys required, instant response, MBBS Bailey/SRB/Robbins
// -------------------------------------------------------------
class OfflineMedicalScanner {
  static get CLINICAL_RULES() {
    return [
      // SURGICAL TRIANGLES & ANATOMICAL DANGER ZONES
      { pattern: /\b(calot|cystohepatic)\b/i, concept: "Calot's Triangle Surgical Anatomy", type: "diagram", query: "Calot triangle laparoscopic cholecystectomy boundary diagram", rationale: "Vital surgical landmark bounded by cystic duct, common hepatic duct, and liver inferior margin to prevent iatrogenic bile duct injury." },
      { pattern: /\b(triangle of doom)\b/i, concept: "Triangle of Doom TEP/TAPP Anatomy", type: "diagram", query: "Triangle of doom external iliac vessels laparoscopic hernia anatomy", rationale: "Bounded by vas deferens and gonadal vessels; contains external iliac artery and vein where tackers must never be placed." },
      { pattern: /\b(triangle of pain)\b/i, concept: "Triangle of Pain TEP/TAPP Anatomy", type: "diagram", query: "Triangle of pain nerves laparoscopic hernia anatomy", rationale: "Contains femoral nerve branch, lateral cutaneous nerve of thigh, and genitofemoral nerve where tacking causes chronic neuralgia." },
      { pattern: /\b(hesselbach|inguinal triangle)\b/i, concept: "Hesselbach's Inguinal Triangle Anatomy", type: "diagram", query: "Hesselbach triangle boundaries direct inguinal hernia diagram", rationale: "Site of direct inguinal hernia protrusion bounded by inferior epigastric artery, rectus abdominis, and inguinal ligament." },
      { pattern: /\b(inguinal canal)\b/i, concept: "Inguinal Canal Layers and Deep/Superficial Rings", type: "diagram", query: "Inguinal canal walls rings spermatic cord anatomy diagram", rationale: "High-yield anatomy showing anterior wall (external oblique), posterior wall (transversalis fascia), roof, and floor." },
      { pattern: /\b(femoral (canal|sheath|hernia))\b/i, concept: "Femoral Canal and Sheath Compartments", type: "diagram", query: "Femoral canal sheath compartments femoral hernia anatomy diagram", rationale: "Crucial for understanding femoral hernia boundaries (lacunar ligament medially, femoral vein laterally) and strangulation risk." },
      { pattern: /\b(rectus sheath)\b/i, concept: "Rectus Sheath Transverse Cross-Section", type: "diagram", query: "Rectus sheath above and below arcuate line diagram cross section", rationale: "Demonstrates fascial arrangement above vs below arcuate line of Douglas and inferior epigastric vessel relations." },
      { pattern: /\b(celiac (axis|trunk))\b/i, concept: "Celiac Axis Branches and Gastric Vascular Arcade", type: "diagram", query: "Celiac trunk branches left gastric splenic common hepatic diagram", rationale: "Foundational vascular anatomy supplying foregut structures: left gastric, splenic, and common hepatic arteries." },
      { pattern: /\b(recurrent laryngeal|rln)\b/i, concept: "Recurrent Laryngeal Nerve Thyroid Anatomy", type: "diagram", query: "Recurrent laryngeal nerve inferior thyroid artery Berry ligament diagram", rationale: "High-risk surgical nerve course in tracheoesophageal groove relation to inferior thyroid artery and ligament of Berry." },
      { pattern: /\b(portosystemic|portal hypertension|esophageal varices)\b/i, concept: "Portosystemic Anastomoses Sites and Collaterals", type: "diagram", query: "Portosystemic venous anastomoses sites portal hypertension diagram", rationale: "Core viva concept covering 4 classic sites of collateral formation: lower esophagus, rectum, umbilicus, and retroperitoneum." },
      { pattern: /\b(couinaud|liver segment)\b/i, concept: "Couinaud Functional Liver Segments (I-VIII)", type: "diagram", query: "Couinaud liver segments I to VIII portal venous hepatic anatomy diagram", rationale: "Essential for liver resections and segmental resections based on portal triad branching and hepatic venous drainage." },

      // RADIOLOGY PATHOGNOMONIC SIGNS
      { pattern: /\b(bird-?beak|rat-?tail)\b/i, concept: "Bird-Beak Sign Barium Swallow in Achalasia", type: "radiology", query: "Achalasia bird beak sign barium swallow radiograph", rationale: "Classic pathognomonic smooth tapered narrowing of lower esophageal sphincter with proximal dilatation." },
      { pattern: /\b(coffee-?bean|omega sign|sigmoid volvulus)\b/i, concept: "Coffee-Bean Sign Plain Abdominal X-Ray", type: "radiology", query: "Sigmoid volvulus coffee bean sign abdominal X ray", rationale: "Pathognomonic inverted U-shaped dilated loop of sigmoid colon originating from left lower quadrant." },
      { pattern: /\b(apple-?core|napkin-?ring)\b/i, concept: "Apple-Core Sign Barium Enema Colorectal Carcinoma", type: "radiology", query: "Apple core lesion colon cancer barium enema X ray", rationale: "Annular constricting carcinoma of the colon producing shouldered margins and central lumen narrowing." },
      { pattern: /\b(double-?bubble)\b/i, concept: "Double-Bubble Sign Duodenal Atresia X-Ray", type: "radiology", query: "Duodenal atresia double bubble sign abdominal radiograph", rationale: "Gas-filled stomach and dilated first/second duodenal part with absent distal bowel gas in neonates." },
      { pattern: /\b(step-?ladder|air-?fluid level)\b/i, concept: "Step-Ladder Air-Fluid Levels Small Bowel Obstruction", type: "radiology", query: "Small bowel obstruction multiple air fluid levels erect X ray", rationale: "Classic erect abdominal radiograph appearance indicating mechanical small bowel obstruction." },
      { pattern: /\b(rigler|pneumoperitoneum|football sign)\b/i, concept: "Rigler Sign and Pneumoperitoneum Signs", type: "radiology", query: "Rigler sign double wall sign pneumoperitoneum abdominal radiograph", rationale: "Double wall sign visualizing both luminal and peritoneal surfaces of bowel wall due to extraluminal free air." },
      { pattern: /\b(whirl sign|target sign|pseudokidney|intussusception)\b/i, concept: "Target Sign / Doughnut Sign and Whirl Sign on CT", type: "radiology", query: "Intussusception target sign ultrasound CT abdomen", rationale: "Concentric rings representing bowel-in-bowel intussusception or mesenteric vessel swirling in volvulus." },
      { pattern: /\b(thumbprinting)\b/i, concept: "Thumbprinting Sign Ischemic Colitis", type: "radiology", query: "Thumbprinting ischemic colitis abdominal radiograph CT", rationale: "Submucosal edema and hemorrhage causing scalloped mucosal indentations resembling thumbprints." },
      { pattern: /\b(string sign of kantor|cobblestone)\b/i, concept: "String Sign of Kantor Barium Study in Crohn's", type: "radiology", query: "Crohn disease string sign of Kantor terminal ileum barium", rationale: "Severe spasm and transmural stricturing of terminal ileum with ulcerated cobblestone mucosa." },
      { pattern: /\b(sentinel loop|colon cut-?off)\b/i, concept: "Sentinel Loop & Colon Cut-Off Sign in Acute Pancreatitis", type: "radiology", query: "Acute pancreatitis sentinel loop colon cut off sign X ray", rationale: "Localized ileus of proximal jejunum and abrupt termination of transverse colon gas due to enzymatic inflammation." },
      { pattern: /\b(eus|endoscopic ultrasound)\b/i, concept: "EUS 5-Layer Wall Anatomy and T-Staging", type: "radiology", query: "Endoscopic ultrasound 5 layers gastrointestinal wall T staging", rationale: "Alternating hyperechoic and hypoechoic layers defining mucosa, submucosa, muscularis propria, and adventitia." },

      // CLASSIFICATIONS, CRITERIA & SCORING
      { pattern: /\b(daintree johnson)\b/i, concept: "Daintree Johnson Classification of Gastric Ulcers", type: "criteria", query: "Daintree Johnson classification gastric ulcer diagram type I to V", rationale: "Standard surgical classification dividing gastric ulcers into Types I-V based on location, acid secretion, and duodenal ulcer association." },
      { pattern: /\b(forrest classif)\b/i, concept: "Forrest Classification Endoscopic Peptic Ulcer Bleeding", type: "criteria", query: "Forrest classification peptic ulcer bleeding endoscopic images table", rationale: "Guides urgent endoscopic intervention vs medical therapy based on spurting, oozing, visible vessel, or clean base." },
      { pattern: /\b(lauren|borrmann)\b/i, concept: "Lauren and Borrmann Classifications of Gastric Cancer", type: "criteria", query: "Borrmann types gastric cancer gross morphology Lauren intestinal diffuse", rationale: "Borrmann types I-IV gross appearance and Lauren intestinal vs diffuse histological subtypes with distinct prognostic profiles." },
      { pattern: /\b(siewert)\b/i, concept: "Siewert Classification of GE Junction Adenocarcinomas", type: "criteria", query: "Siewert classification gastroesophageal junction type I II III diagram", rationale: "Categorizes GEJ tumors into Type I (distal esophagus), Type II (true cardia), and Type III (subcardial gastric) to determine surgical approach." },
      { pattern: /\b(alvarado)\b/i, concept: "Alvarado MANTRELS Scoring Table for Acute Appendicitis", type: "criteria", query: "Alvarado score table acute appendicitis criteria scoring", rationale: "Widely tested clinical risk scoring system based on symptoms, signs, and laboratory values." },
      { pattern: /\b(atlanta|balthazar|ctsi)\b/i, concept: "Revised Atlanta 2012 Classification & Balthazar CTSI", type: "criteria", query: "Revised Atlanta classification acute pancreatitis interstitial necrotizing fluid collections", rationale: "Defines acute peripancreatic fluid collections, pseudocyst, acute necrotic collection (ANC), and walled-off necrosis (WON)." },
      { pattern: /\b(child-?pugh|meld)\b/i, concept: "Child-Pugh Score & MELD Criteria Table", type: "criteria", query: "Child Pugh score classification liver cirrhosis encephalopathy ascites table", rationale: "Stratifies perioperative surgical risk in cirrhosis across bilirubin, albumin, INR, ascites, and encephalopathy." },
      { pattern: /\b(hinchey)\b/i, concept: "Modified Hinchey Classification of Diverticulitis", type: "criteria", query: "Hinchey classification diverticulitis stage I II III IV CT diagram", rationale: "Essential staging from pericolic phlegmon (Stage I) to purulent peritonitis (Stage III) and feculent peritonitis (Stage IV)." },
      { pattern: /\b(bismuth-?corlette)\b/i, concept: "Bismuth-Corlette Classification of Hilar Cholangiocarcinoma", type: "criteria", query: "Bismuth Corlette classification hilar cholangiocarcinoma Klatskin diagram", rationale: "Determines resectability of Klatskin tumors based on involvement of common hepatic duct and intrahepatic confluence." },
      { pattern: /\b(todani)\b/i, concept: "Todani Classification of Choledochal Cysts (Types I-V)", type: "criteria", query: "Todani classification choledochal cysts type I II III IV V diagram", rationale: "Guides surgical excision vs drainage based on cystic dilatation of extrahepatic and intrahepatic biliary tree." },
      { pattern: /\b(nyhus|gilbert)\b/i, concept: "Nyhus and Gilbert Classifications of Inguinal Hernias", type: "criteria", query: "Nyhus classification hernia type I II III IV table diagram", rationale: "Categorizes hernias by deep ring integrity, posterior wall floor defect, femoral involvement, and recurrence." },
      { pattern: /\b(ranson|glasgow)\b/i, concept: "Ranson Criteria for Acute Pancreatitis Prognosis", type: "criteria", query: "Ranson criteria acute pancreatitis at admission 48 hours table", rationale: "Predicts mortality at admission (GALAW) and within 48 hours (CHOBBS) in gallstone vs non-gallstone pancreatitis." },

      // SURGICAL PROCEDURES & OPERATIVE REPAIRS
      { pattern: /\b(vagotomy|truncal vagotomy|hsv|latarjet)\b/i, concept: "Truncal, Selective & Highly Selective Vagotomy Anatomy", type: "clinical", query: "Vagotomy truncal selective highly selective nerve of Grassi Latarjet crows foot diagram", rationale: "Detailed nerve anatomy contrasting TV (division of main trunks) vs HSV (denervating parietal cell mass while preserving crow's foot)." },
      { pattern: /\b(graham patch|cellan-?jones)\b/i, concept: "Graham & Cellan-Jones Omental Patch Repair Technique", type: "clinical", query: "Graham patch repair perforated peptic ulcer operative steps diagram", rationale: "Standard operative repair of perforated duodenal/gastric ulcer utilizing vascularized pedicled omental plug." },
      { pattern: /\b(billroth|roux-?en-?y|gastrectomy)\b/i, concept: "Billroth I, Billroth II and Roux-en-Y Reconstruction", type: "clinical", query: "Billroth I vs Billroth II vs Roux en Y gastrectomy diagram", rationale: "Classic surgical reconstructions following partial gastrectomy illustrating gastrojejunostomy anastomoses and loop orientations." },
      { pattern: /\b(whipple|pancreaticoduodenectomy)\b/i, concept: "Whipple Procedure (Pancreaticoduodenectomy) Resection & Reconstruction", type: "clinical", query: "Whipple procedure pancreaticoduodenectomy resection reconstruction anastomoses diagram", rationale: "Master surgical operation showing pancreaticojejunostomy, hepaticojejunostomy, and gastrojejunostomy." },
      { pattern: /\b(d1 vs d2|d2 dissection|d1 dissection|lymphadenectomy)\b/i, concept: "Gastric Cancer D1 vs D2 Lymph Node Stations", type: "diagram", query: "Gastric cancer D1 D2 lymph node stations Japanese classification diagram", rationale: "Contrasts perigastric stations 1-6 with extra-perigastric stations 7-12 along celiac axis, splenic and hepatic vessels." },
      { pattern: /\b(lichtenstein|shouldice|tapp|tep)\b/i, concept: "Lichtenstein Mesh vs Shouldice Repair Anatomy", type: "clinical", query: "Lichtenstein tension free mesh repair inguinal hernia operative steps diagram", rationale: "Key steps in tension-free polypropylene mesh placement and fixation to pubic tubercle and inguinal ligament." },
      { pattern: /\b(hartmann|miles|abdominoperineal)\b/i, concept: "Hartmann's Procedure vs Miles APR Operative Diagrams", type: "clinical", query: "Hartmann procedure end colostomy rectal stump diagram", rationale: "Comparison between rectosigmoid resection with end colostomy closure vs complete abdominoperineal resection." },
      { pattern: /\b(curling|cushing)\b/i, concept: "Curling's vs Cushing's Stress Ulcers Pathophysiology", type: "clinical", query: "Curling ulcer vs Cushing ulcer mechanism burns head injury table", rationale: "Contrasts hypovolemia-induced mucosal ischemia in burn patients vs intracranial pressure-induced vagal acid hypersecretion." },
      { pattern: /\b(dumping syndrome)\b/i, concept: "Early vs Late Dumping Syndrome Pathophysiology", type: "clinical", query: "Early vs late dumping syndrome pathophysiology timeline table", rationale: "Contrasts hyperosmolar rapid small bowel fluid shift (early, 15-30m) vs reactive hypoglycemia from hyperinsulinemia (late, 2-3h)." },
      { pattern: /\b(sma syndrome|wilkie|median arcuate|dunbar)\b/i, concept: "SMA Syndrome (Wilkie's) & MALS (Dunbar's) Anatomy", type: "radiology", query: "Superior mesenteric artery syndrome aortomesenteric angle CT angiogram diagram", rationale: "Demonstrates vascular compression of third part of duodenum between aorta and superior mesenteric artery." },

      // HPE / PATHOLOGY
      { pattern: /\b(signet-?ring)\b/i, concept: "Signet-Ring Cell Carcinoma Histopathology (H&E)", type: "histology", query: "Signet ring cell gastric adenocarcinoma histology HE stain", rationale: "Microscopic hallmark featuring intracytoplasmic mucin vacuole pushing hyperchromatic nucleus to cell periphery." },
      { pattern: /\b(reed-?sternberg)\b/i, concept: "Reed-Sternberg Cells in Hodgkin Lymphoma", type: "histology", query: "Reed Sternberg cell owl eye nuclei Hodgkin lymphoma histology", rationale: "Giant binucleated or multinucleated neoplastic cells with prominent eosinophilic inclusion-like nucleoli and clear halos." },
      { pattern: /\b(psammoma)\b/i, concept: "Psammoma Bodies in Histopathology", type: "histology", query: "Psammoma bodies papillary thyroid carcinoma meningioma histology", rationale: "Concentric laminated calcium calcifications characteristic of papillary thyroid cancer and meningioma." },
      { pattern: /\b(orphan annie)\b/i, concept: "Orphan Annie Eye Nuclei in Papillary Thyroid Carcinoma", type: "histology", query: "Orphan Annie eye nuclei papillary thyroid carcinoma histology", rationale: "Optically clear, ground-glass nuclei with nuclear grooves and pseudo-inclusions." },
      { pattern: /\b(correa cascade)\b/i, concept: "Correa Cascade of Gastric Carcinogenesis Flowchart", type: "criteria", query: "Correa cascade gastric carcinogenesis normal gastritis metaplasia dysplasia adenocarcinoma", rationale: "Sequential progression from normal mucosa to gastritis, intestinal metaplasia, dysplasia, and adenocarcinoma." },
      { pattern: /\b(virchow|troisier|krukenberg|blumer|sister mary joseph)\b/i, concept: "Metastatic Signposts of Gastrointestinal Malignancy", type: "clinical", query: "Virchow node Krukenberg tumor Blumer shelf Sister Mary Joseph nodule diagram", rationale: "Classic surgical exam spots demonstrating left supraclavicular, ovarian, pelvic pouch, and periumbilical metastases." }
    ];
  }

  async scanNote(noteTitle, noteContent, maxSuggestions = 20, onProgress = null) {
    if (onProgress) onProgress("Running Local Medical Rules Engine...");
    maxSuggestions = maxSuggestions || 20;

    const allLines = noteContent.split(/\r?\n/);
    const totalLines = allLines.length;
    let totalImagesFound = 0;
    allLines.forEach(l => { totalImagesFound += (l.match(/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/g) || []).length; });

    const sectionList = [];
    let currentHeading = "Introduction";
    const lineHeadings = [];

    allLines.forEach((line, idx) => {
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        currentHeading = hm[2].replace(/[#*`_]/g, "").trim();
        sectionList.push({ line: idx + 1, heading: currentHeading });
      }
      lineHeadings.push(currentHeading);
    });

    const matchedSuggestions = [];
    const seenQueries = new Set();
    const rules = OfflineMedicalScanner.CLINICAL_RULES;

    for (let i = 0; i < allLines.length; i++) {
      if (matchedSuggestions.length >= maxSuggestions * 2) break;
      const lineText = allLines[i];
      if (!lineText || lineText.trim().length < 4) continue;
      if (/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/.test(lineText)) continue;

      for (const rule of rules) {
        if (rule.pattern.test(lineText)) {
          if (!seenQueries.has(rule.query)) {
            seenQueries.add(rule.query);
            matchedSuggestions.push({
              heading: lineHeadings[i] || noteTitle,
              line: i + 1,
              visualConcept: rule.concept,
              visualType: rule.type,
              rationale: rule.rationale,
              recommendedQuery: rule.query
            });
            if (matchedSuggestions.length >= maxSuggestions * 2) break;
          }
        }
      }
    }

    if (matchedSuggestions.length < maxSuggestions) {
      for (const sec of sectionList) {
        if (matchedSuggestions.length >= maxSuggestions) break;
        const hText = sec.heading;
        const cleanTitle = hText.replace(/Part \d+.*?\s*/i, "").replace(/Chapter.*?:/i, "").trim();
        const genericQuery = `${cleanTitle} surgical anatomy medical diagram labeled`;
        if (!seenQueries.has(genericQuery) && cleanTitle.length >= 3) {
          seenQueries.add(genericQuery);
          matchedSuggestions.push({
            heading: sec.heading,
            line: sec.line,
            visualConcept: `${cleanTitle} Key Anatomy / Procedure`,
            visualType: "diagram",
            rationale: `Core section covering ${cleanTitle} requiring visual representation for exam retention.`,
            recommendedQuery: genericQuery
          });
        }
      }
    }

    if (matchedSuggestions.length === 0) {
      return {
        summary: `Local Medical Rules Engine identified 0 visual opportunities across ${sectionList.length} sections.`,
        existingImages: totalImagesFound,
        suggestions: []
      };
    }

    const sanitized = GeminiScannerService.sanitizeSuggestions({
      summary: `Local Medical Rules Engine identified ${matchedSuggestions.length} high-yield visual opportunities across ${sectionList.length} sections.`,
      suggestions: matchedSuggestions
    }, totalLines, maxSuggestions);

    return {
      summary: sanitized.summary,
      existingImages: totalImagesFound,
      suggestions: sanitized.suggestions
    };
  }
}

// -------------------------------------------------------------
// Groq AI Scanner (free-tier friendly alternative to Gemini)
// 14,400 req/day, auto-discovers active live models — no 503s
// -------------------------------------------------------------
class GroqScannerService {
  constructor(apiKey, model, plugin = null) {
    this.apiKey = (apiKey || '').trim();
    this.model  = model || 'llama-3.1-8b-instant';
    this.plugin = plugin;
  }

  static async fetchAvailableModels(apiKey) {
    if (!apiKey) return [];
    try {
      const res = await requestUrl({
        url: 'https://api.groq.com/openai/v1/models',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + apiKey.trim(),
          'Content-Type': 'application/json'
        }
      });
      const data = res.json && res.json.data;
      if (!Array.isArray(data)) return [];
      return data
        .filter(m => m && m.id && !m.id.includes('whisper') && !m.id.includes('guard') && !m.id.includes('safeguard'))
        .map(m => m.id);
    } catch (_) {
      return [];
    }
  }

  async scanNote(noteTitle, noteContent, maxSuggestions, onProgress) {
    if (!this.apiKey) throw new Error('Groq API key is missing. Enter it in Settings → Medical Image Finder.');
    maxSuggestions = maxSuggestions || 20;

    const allLines = noteContent.split(/\r?\n/);
    const totalLines = allLines.length;
    let totalImagesFound = 0;
    allLines.forEach(l => { totalImagesFound += (l.match(/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/g) || []).length; });

    const digest = GeminiScannerService._buildDigest(allLines);
    if (onProgress) onProgress('Built digest (' + Math.round(digest.length / 1000) + 'k chars). Querying Groq...');

    const systemPrompt = `You are an expert MBBS medical educator (Bailey & Love Surgery, SRB, Gray's Anatomy, Robbins Pathology).
Analyze the medical note digest below. Each line is prefixed with [L<number>] showing the original note line number.
Find every location that needs a visual image for better MBBS exam/viva performance.

VISUAL CATEGORIES TO FIND:
1. ANATOMY/DIAGRAM: surgical triangles, fascial layers, canals, nerve/vascular diagrams, cross-sections, lymph drainage
2. RADIOLOGY: pathognomonic X-ray/CT/MRI/USG/barium signs (bird-beak, coffee-bean, whirl sign, target sign, etc.)
3. HPE/HISTOLOGY: H&E patterns, Reed-Sternberg, Psammoma bodies, Signet-ring, gross pathology
4. CLINICAL/SURGICAL: operative steps, repair layers, incisions, examination findings
5. CRITERIA/SCORING: scoring systems, diagnostic criteria tables, staging/grading, management flowcharts
6. EMBRYOLOGY/PHYSIO: developmental diagrams, physiology graphs, drug mechanism diagrams

RULES:
- Use the L<number> prefix to report the EXACT line number for each suggestion
- Give a specific 5-8 keyword search query that will find the best labeled medical image
- visualType must be one of: "diagram","radiology","histology","clinical","criteria","embryology"

OUTPUT: valid JSON only, no markdown fences:
{"summary":"one sentence","suggestions":[{"heading":"section heading","line":42,"visualConcept":"specific image title","visualType":"diagram","rationale":"why high-yield (2 sentences)","recommendedQuery":"5-8 keywords"}]}
Return at most ` + maxSuggestions + ` suggestions ranked by educational impact.`;

    const userContent = 'Note: "' + noteTitle + '" | Lines: ' + totalLines + ' | Existing images: ' + totalImagesFound + '\n\n' + digest;

    let availableModels = [];
    try {
      if (onProgress) onProgress('Verifying active models on your Groq account...');
      availableModels = await GroqScannerService.fetchAvailableModels(this.apiKey);
    } catch (_) {}

    let modelsToTry = [];
    const DECOMMISSIONED = ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it', 'llama-3.1-70b-versatile'];

    if (availableModels.length > 0) {
      if (this.model && availableModels.includes(this.model) && !DECOMMISSIONED.includes(this.model)) {
        modelsToTry.push(this.model);
      }
      const instant8b = availableModels.filter(m => m.includes('8b-instant'));
      const llama70b = availableModels.filter(m => m.includes('70b') && !modelsToTry.includes(m));
      const others = availableModels.filter(m => !modelsToTry.includes(m) && !instant8b.includes(m) && !llama70b.includes(m));
      modelsToTry.push(...instant8b, ...llama70b, ...others);
    } else {
      modelsToTry = [
        'llama-3.1-8b-instant',
        'llama-3.3-70b-versatile',
        'llama-3.2-11b-vision-preview',
        'llama-3.2-3b-preview',
        'llama-3.2-1b-preview'
      ];
      if (this.model && !DECOMMISSIONED.includes(this.model) && !modelsToTry.includes(this.model)) {
        modelsToTry.unshift(this.model);
      }
    }
    modelsToTry = Array.from(new Set(modelsToTry));

    const TIMEOUT_MS = 60000;
    let response, lastErr, successfulModel = null;

    for (const modelId of modelsToTry) {
      if (onProgress) onProgress('Scanning with Groq (' + modelId + ')...');
      const payload = JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      let modelSucceeded = false;
      for (let attempt = 0; attempt <= 1; attempt++) {
        let timerId;
        try {
          const apiCall = requestUrl({
            url: 'https://api.groq.com/openai/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + this.apiKey
            },
            body: payload
          });
          const timer = new Promise((_, rej) => {
            timerId = setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT_MS);
          });
          response = await Promise.race([apiCall, timer]);
          successfulModel = modelId;
          modelSucceeded = true;
          break;
        } catch (err) {
          lastErr = err;
          const status = err && (err.status || err.statusCode || 0);
          if (status === 400 || status === 404) {
            break; // model decommissioned or not found -> advance to next model immediately
          }
          if (status === 429 || status === 503) {
            if (attempt === 0) {
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
            break;
          }
          break;
        } finally {
          if (timerId) clearTimeout(timerId);
        }
      }
      if (modelSucceeded) break;
    }

    if (!response) {
      throw new Error('Groq scan failed on all tested models (' + modelsToTry.slice(0, 3).join(', ') + '). Last error: ' + safeError(lastErr));
    }

    if (successfulModel && this.plugin && this.plugin.settings) {
      this.plugin.settings.groqModel = successfulModel;
      this.plugin.saveSettings().catch(() => {});
    }

    const data = response.json;
    const rawText = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!rawText) throw new Error('Groq returned no content. Try again.');

    const parsed = GeminiScannerService._parseJsonSafely(rawText, maxSuggestions);
    return {
      summary: parsed.summary || ('Scan complete via Groq (' + successfulModel + ').'),
      existingImages: totalImagesFound,
      suggestions: (parsed.suggestions || []).slice(0, maxSuggestions).filter(s =>
        s && typeof s.heading === 'string' && typeof s.visualConcept === 'string' &&
        typeof s.recommendedQuery === 'string' && Number.isInteger(s.line) && s.line >= 1
      )
    };
  }
}

// -------------------------------------------------------------
// Gemini AI Note Visual Scanner Service
// -------------------------------------------------------------
// -------------------------------------------------------------
// OpenAI-Compatible Universal Scanner (OpenRouter, Cerebras, etc.)
// Supports any provider from https://github.com/mnfst/awesome-free-llm-apis
// -------------------------------------------------------------
class OpenAiCompatibleScannerService {
  constructor(baseUrl, apiKey, model) {
    this.baseUrl = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.apiKey = (apiKey || '').trim();
    this.model = model || 'meta-llama/llama-3.3-70b-instruct:free';
  }

  async scanNote(noteTitle, noteContent, maxSuggestions = 20, onProgress = null) {
    if (!this.apiKey) {
      throw new Error('API key is missing for the OpenAI-compatible provider. Enter it in Settings.');
    }

    const allLines = noteContent.split(/\r?\n/);
    const totalLines = allLines.length;
    let totalImagesFound = 0;
    allLines.forEach(l => { totalImagesFound += (l.match(/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/g) || []).length; });

    if (onProgress) onProgress('Preparing full note for ' + this.model + ' (' + totalLines + ' lines)...');

    const fullNumberedText = allLines.map((l, i) => `[L${i + 1}] ${l}`).join('\n');

    const systemPrompt = `You are an expert MBBS medical educator (Bailey & Love Surgery, SRB, Gray's Anatomy, Robbins Pathology).
Analyze the complete medical note below. Each line is prefixed with [L<number>] showing the original note line number.
Identify every high-yield location that needs an anatomical diagram, radiology sign, surgical repair view, criteria table, or histopathology image.

OUTPUT: valid JSON only, no markdown fences:
{"summary":"one sentence","suggestions":[{"heading":"section heading","line":42,"visualConcept":"specific image title","visualType":"diagram","rationale":"why high-yield (2 sentences)","recommendedQuery":"5-8 keywords"}]}
visualType must be one of: "diagram","radiology","histology","clinical","criteria","embryology"
Return at most ${maxSuggestions} suggestions.`;

    const userContent = `Note: "${noteTitle}" | Lines: ${totalLines} | Existing images: ${totalImagesFound}\n\n${fullNumberedText}`;

    if (onProgress) onProgress('Scanning full note via ' + this.baseUrl + ' (' + this.model + ')...');

    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2
    });

    const response = await requestUrl({
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.apiKey
      },
      body: payload
    });

    const data = response.json;
    const rawText = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!rawText) throw new Error('Provider returned no content. Try another model or check rate limits.');

    const parsed = GeminiScannerService._parseJsonSafely(rawText, maxSuggestions);
    return {
      summary: parsed.summary || ('Scan complete via ' + this.model),
      existingImages: totalImagesFound,
      suggestions: (parsed.suggestions || []).slice(0, maxSuggestions).filter(s =>
        s && typeof s.heading === 'string' && typeof s.visualConcept === 'string' &&
        typeof s.recommendedQuery === 'string' && Number.isInteger(s.line) && s.line >= 1
      )
    };
  }
}

class GeminiScannerService {
  constructor(apiKey, model = "gemini-2.5-flash", plugin = null) {
    this.apiKey = (apiKey || "").trim();
    this.model  = model || "gemini-2.5-flash";
    this.plugin = plugin;
  }

  static _buildDigest(allLines) {
    return allLines.slice(0, 400).map((l, i) => `[L${i + 1}] ${l}`).join('\n');
  }

  static normalizeVisualType(typeStr) {
    if (!typeStr) return "diagram";
    const lower = String(typeStr).toLowerCase();
    if (lower.includes("radio") || lower.includes("x-ray") || lower.includes("ct") || lower.includes("mri") || lower.includes("barium")) return "radiology";
    if (lower.includes("histo") || lower.includes("path") || lower.includes("micro") || lower.includes("hpe")) return "histology";
    if (lower.includes("clin") || lower.includes("surg") || lower.includes("operat")) return "clinical";
    if (lower.includes("crit") || lower.includes("score") || lower.includes("classif") || lower.includes("table")) return "criteria";
    if (lower.includes("embryo") || lower.includes("physio")) return "embryology";
    return "diagram";
  }

  static simplifySearchQuery(query, fallbackConcept = "", visualType = "diagram") {
    if (!query || typeof query !== "string") {
      query = fallbackConcept || "medical diagram";
    }

    let q = query.trim();

    // 1. Remove wrapping quotes, backticks, brackets
    q = q.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "").trim();
    q = q.replace(/[*_`]/g, " ");

    // 2. Remove parenthetical acronyms, notes, or synonyms e.g. (PJ, HJ, GJ), (Jurasz), (contrast)
    q = q.replace(/\s*\([^)]*\)/g, " ");

    // 3. Remove conversational or redundant search prefixes
    q = q.replace(/^(?:search(?:\s+for)?|find|images?\s+of|illustrations?\s+of|schematics?\s+of|pictures?\s+of|photos?\s+of|drawings?\s+of|diagram\s+of)\s+/i, "");

    // 4. Remove clustered surgical/anatomical acronyms (e.g. PJ HJ GJ, SMA SMV GDA, CBD)
    q = q.replace(/\b(?:PJ|HJ|GJ)\b/gi, " ");
    q = q.replace(/\b[A-Z]{2,3}(?:\s+[A-Z]{2,3}){1,}\b/g, " ");

    // 5. Remove clutter / meta buzzwords and low-value clinical filler
    q = q.replace(/\b(?:high[- ]yield|high[- ]resolution|high[- ]res|hd|4k|for\s+medical\s+students|exam\s+revision|neet[- ]pg|usmle|mbbs\s+proff?s?)\b/gi, " ");
    q = q.replace(/\b(?:showing|depicting|demonstrating|illustrating|revealing)\b/gi, " ");
    q = q.replace(/\b(?:smooth tapering|dilated loop|erect view|plain radiograph|plain|erect|comparative)\b/gi, " ");
    q = q.replace(/\b(?:microscopic|appearance|assessment)\b/gi, " ");
    q = q.replace(/\b(?:surface landmark|anatomical surface)\b/gi, " ");
    q = q.replace(/\b(?:owl eye|owl-eye)\b/gi, " ");
    q = q.replace(/\b(?:HE stain|H&E stain|HE|H&E)\b/gi, " ");

    // 6. Simplify known redundant medical synonym pairings
    if (/\bwhipple\b/i.test(q) && /\bpancreaticoduodenectomy\b/i.test(q)) {
      q = q.replace(/\bpancreaticoduodenectomy\b/gi, "procedure");
    }
    if (/\b(?:cystogastrostomy)\b/i.test(q) && /\b(?:cystojejunostomy)\b/i.test(q)) {
      q = q.replace(/\b(?:Jurasz|Roux-en-Y\s+cystojejunostomy|cystojejunostomy)\b/gi, " ");
    }
    if (/\bpancreaticoduodenal\b/i.test(q) && /\barterial\s+arcade\b/i.test(q)) {
      q = q.replace(/\b(?:arterial\s+arcade\s+gastroduodenal\s+superior\s+mesenteric\s+artery|gastroduodenal\s+superior\s+mesenteric\s+artery|gastroduodenal|superior\s+mesenteric\s+artery)\b/gi, "blood supply");
    }

    // 7. Replace noisy punctuation (commas, slashes, semicolons, colons, pipes) with spaces
    q = q.replace(/[,:;/|\\+]/g, " ");

    // 8. Normalize whitespace
    q = q.replace(/\s+/g, " ").trim();

    // 9. Deduplicate repeated words (case-insensitive)
    const words = q.split(" ").filter(Boolean);
    const seen = new Set();
    const deduped = [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        deduped.push(w);
      }
    }

    // 10. If query is overly long (> 7 words), simplify to keep essential keywords + anchor
    if (deduped.length > 7) {
      const stopwords = new Set(["the", "a", "an", "and", "or", "of", "in", "for", "with", "to", "at", "by", "from"]);
      const filtered = deduped.filter(w => !stopwords.has(w.toLowerCase()));
      if (filtered.length >= 3 && filtered.length <= 7) {
        q = filtered.join(" ");
      } else if (filtered.length > 7) {
        const anchors = ["diagram", "sign", "x-ray", "ct", "mri", "histology", "table", "anatomy", "illustration", "spotter", "ultrasound", "usg", "appearance"];
        const lastWord = filtered[filtered.length - 1];
        const hasAnchor = anchors.includes(lastWord.toLowerCase());
        if (hasAnchor) {
          q = filtered.slice(0, 4).concat(lastWord).join(" ");
        } else {
          q = filtered.slice(0, 5).join(" ");
        }
      } else {
        q = deduped.slice(0, 6).join(" ");
      }
    } else {
      q = deduped.join(" ");
    }

    // Final cleanup of extra spaces or duplicate adjacent words
    q = q.replace(/\b(\w+)\s+\1\b/gi, "$1").replace(/\s+/g, " ").trim();

    if (!q) {
      q = (fallbackConcept || "medical") + " " + (visualType === "radiology" ? "x-ray" : "diagram");
    }

    return q;
  }

  static scoreHighYield(suggestion) {
    let score = 0;
    const type = (suggestion.visualType || "").toLowerCase();
    const concept = (suggestion.visualConcept || "").toLowerCase();
    const heading = (suggestion.heading || "").toLowerCase();
    const rationale = (suggestion.rationale || "").toLowerCase();
    const query = (suggestion.recommendedQuery || "").toLowerCase();
    const combined = `${heading} ${concept} ${rationale} ${query}`;

    // 1. Anatomy Triangles, Relations, Boundaries, Blood Supply
    if (/\btriangle\b|\btriangles\b/.test(combined)) score += 30;
    if (/\b(?:calot|hesselbach|scarpa|femoral|carotid|submandibular|digastric|muscular|suboccipital|codman|trapezoid|killian|lumbocostal|bouchet|koch|grynfeltt|petit|haselbach|passaro)\b/.test(combined)) score += 35;
    if (/\b(?:boundaries|relations|borders|contents|walls|floor|roof)\b/.test(combined)) score += 20;
    if (/\b(?:canal|sheath|fascia|fascial|arcade|space|hiatus|foramen|compartment)\b/.test(combined)) score += 15;
    if (/\b(?:blood supply|nerve supply|arterial|innervation|lymphatic drainage|anastomosis|anastomoses|course|branches)\b/.test(combined)) score += 15;

    // 2. Pathognomonic Radiology Signs & Spotters
    if (/\bpathognomonic\b/.test(combined)) score += 35;
    if (/\b(?:x-ray|radiograph|radiology|ct|mri|usg|ultrasound|barium swallow|barium enema)\b/.test(combined)) score += 15;
    if (/\b(?:sign|spotter|appearance|pattern)\b/.test(combined)) score += 20;
    if (/\b(?:double[- ]bubble|bird[- ]beak|coffee[- ]bean|apple[- ]core|whirl|target|stepladder|step[- ]ladder|string sign|lead pipe|thumbprint|rigler|pneumoperitoneum|crescent|hair[- ]on[- ]end|sunburst|codman|water[- ]lily|meniscus)\b/.test(combined)) score += 35;

    // 3. Classification Tables, Staging, Diagnostic Scoring Systems
    if (/\b(?:classification|criteria|score|scoring|staging|system|grades?|grading)\b/.test(combined)) score += 25;
    if (/\btable\b/.test(combined)) score += 15;
    if (/\b(?:alvarado|ranson|child[- ]pugh|meld|forrest|lauren|borrmann|siewert|todani|hinchey|bismuth|ann[- ]arbor|tnm|glasgow|wells|curb[- ]65|apgar|bishop|mallampati|nyha|killip|rockall|cha2ds2|cha2ds2[- ]vasc|has[- ]bled)\b/.test(combined)) score += 35;

    // 4. Pathology Hallmarks & HPE
    if (/\b(?:hallmark|hallmarks|microscopic hallmark)\b/.test(combined)) score += 25;
    if (/\b(?:histology|pathology|hpe|microscopic|biopsy|smear)\b/.test(combined)) score += 15;
    if (/\b(?:reed[- ]sternberg|psammoma|orphan annie|signet[- ]ring|call[- ]exner|auer rod|kimmelstiel|homer[- ]wright|schiller[- ]duval|councilman|negri|lewys?|cowdry|granuloma|caseous|aschoff|caterpillar|ferruginous|rosette)\b/.test(combined)) score += 35;

    // 5. Physiology Curves, Graphs, Cycles & Mechanisms
    if (/\b(?:curve|curves|graph|flowchart|action potential|cycle|loop|axis|reflex|pathway|regulation)\b/.test(combined)) score += 20;
    if (/\b(?:frank[- ]starling|oxygen dissociation|oxygen[- ]hemoglobin|compliance|pressure[- ]volume|cardiac cycle|renin[- ]angiotensin|hypothalamic|coagulation cascade|nephron)\b/.test(combined)) score += 30;

    // 6. Clinical / Surgical Hallmarks & Signs
    if (/\b(?:whipple|billroth|roux[- ]en[- ]y|graham patch|bassini|shouldice|lichtenstein|hartmann|laparoscopy|cholecystectomy|appendectomy|mastectomy|thyroidectomy|stoma|colostomy|ileostomy|reconstruction|repair|shunt)\b/.test(combined)) score += 30;
    if (/\b(?:cullen|grey[- ]turner|murphy|mcburney|blumberg|rovsing|kehr|chvostek|trousseau|courvoisier|battle|raccoon|tinel|phalen|homans|psoas|obturator)\b/.test(combined)) score += 30;

    // Educational / High-yield buzzwords in rationale
    if (/\b(?:high[- ]yield|gold standard|exam|viva|hallmark|classic|triad|pentad|rule of)\b/.test(rationale)) score += 15;

    // Modest category bonus (0-5) only if type is recognized
    if (type === "radiology" || type === "criteria") score += 5;
    else if (type === "diagram" || type === "histology" || type === "clinical" || type === "embryology") score += 3;

    return score;
  }

  static sanitizeSuggestions(data, maxLines = Infinity, maxSuggestions = 25) {
    const summary = (data && typeof data.summary === "string" && data.summary.trim())
      ? data.summary.trim()
      : "Identified high-yield visual opportunities across the note.";
    const rawList = Array.isArray(data?.suggestions) ? data.suggestions : [];
    const valid = [];
    for (let i = 0; i < rawList.length; i++) {
      const s = rawList[i];
      if (!s) continue;
      const lineMatch = String(s.line !== undefined ? s.line : "").match(/\d+/);
      let line = lineMatch ? parseInt(lineMatch[0], 10) : 1;
      if (isNaN(line) || line < 1) line = 1;
      if (maxLines !== Infinity && line > maxLines) line = Math.min(line, maxLines);

      const heading = String(s.heading || "General").trim();
      const visualConcept = String(s.visualConcept || s.concept || s.title || heading || "Visual Reference").trim();
      const visualType = GeminiScannerService.normalizeVisualType(s.visualType || s.type);
      const rationale = String(s.rationale || s.reason || "High-yield visual gap for exam revision.").trim();
      let query = String(s.recommendedQuery || s.query || s.searchQuery || visualConcept).trim();
      const simplifiedQuery = GeminiScannerService.simplifySearchQuery(query, visualConcept, visualType);

      valid.push({
        _origIdx: i,
        heading,
        line,
        visualConcept,
        visualType,
        rationale,
        recommendedQuery: simplifiedQuery
      });
    }
    if (valid.length === 0) {
      throw new Error("No valid visual suggestions found in response.");
    }

    const cap = Math.min((typeof maxSuggestions === "number" && maxSuggestions > 0) ? maxSuggestions : 25, 50);
    let resultList;
    if (valid.length > cap) {
      // Score and select the top high-yield concepts for NEET-PG / MBBS Proffs
      for (const item of valid) {
        item._score = GeminiScannerService.scoreHighYield(item);
      }
      valid.sort((a, b) => (b._score - a._score) || (a._origIdx - b._origIdx));
      const topSelected = valid.slice(0, cap);
      // Strictly sort the selected suggestions by ascending line number
      topSelected.sort((a, b) => (a.line - b.line) || (a._origIdx - b._origIdx));
      resultList = topSelected;
    } else {
      // Strictly sort by line in ascending order
      valid.sort((a, b) => (a.line - b.line) || (a._origIdx - b._origIdx));
      resultList = valid;
    }

    // Clean up internal metadata fields
    for (const item of resultList) {
      delete item._origIdx;
      delete item._score;
    }

    return { summary, suggestions: resultList };
  }

  static parseMarkdownTable(text, maxLines = Infinity, maxSuggestions = 25) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const tableLines = lines.filter(l => l.startsWith("|") && l.endsWith("|"));
    if (tableLines.length < 2) return null;

    let headerIndex = -1;
    for (let i = 0; i < tableLines.length; i++) {
      const lower = tableLines[i].toLowerCase();
      if (lower.includes("line") || lower.includes("concept") || lower.includes("query") || lower.includes("heading")) {
        headerIndex = i;
        break;
      }
    }
    if (headerIndex === -1) return null;

    const parseCells = row => row.split("|").slice(1, -1).map(c => c.trim());
    const headers = parseCells(tableLines[headerIndex]).map(h => h.toLowerCase().replace(/[*_`]/g, ""));

    const lineIdx = headers.findIndex(h => h.includes("line"));
    const headIdx = headers.findIndex(h => h.includes("head") || h.includes("sec"));
    const conceptIdx = headers.findIndex(h => h.includes("concept") || h.includes("title") || (h.includes("visual") && !h.includes("type")));
    const typeIdx = headers.findIndex(h => h.includes("type") || h.includes("category"));
    const ratIdx = headers.findIndex(h => h.includes("rationale") || h.includes("reason") || h.includes("why") || h.includes("desc"));
    const queryIdx = headers.findIndex(h => h.includes("query") || h.includes("search") || h.includes("duckduckgo"));

    const suggestions = [];
    for (let i = headerIndex + 1; i < tableLines.length; i++) {
      const row = tableLines[i];
      if (/^[|\s\-:]+$/.test(row)) continue;
      const cells = parseCells(row);
      if (cells.length < 2) continue;

      let line = 1;
      if (lineIdx !== -1 && cells[lineIdx]) {
        const m = cells[lineIdx].match(/(?:\[?L?)(\d+)\]?/i);
        if (m) line = parseInt(m[1], 10);
      }

      const heading = (headIdx !== -1 && cells[headIdx]) ? cells[headIdx].replace(/[*_`]/g, "").trim() : "General";
      const visualConcept = (conceptIdx !== -1 && cells[conceptIdx]) ? cells[conceptIdx].replace(/[*_`]/g, "").trim() : (heading || "Medical Visual");
      const visualType = GeminiScannerService.normalizeVisualType(typeIdx !== -1 ? cells[typeIdx] : "diagram");
      const rationale = (ratIdx !== -1 && cells[ratIdx]) ? cells[ratIdx].replace(/[*_`]/g, "").trim() : "High-yield visual gap for clinical understanding and exam revision.";
      let query = (queryIdx !== -1 && cells[queryIdx]) ? cells[queryIdx].replace(/[*_`'"]/g, "").trim() : visualConcept;

      if (!query) query = visualConcept + " " + (visualType === "diagram" ? "anatomy diagram" : visualType);

      suggestions.push({
        heading: heading || "General",
        line: isNaN(line) || line < 1 ? 1 : (maxLines !== Infinity && line > maxLines ? Math.min(line, maxLines) : line),
        visualConcept: visualConcept || "Medical Visual",
        visualType,
        rationale,
        recommendedQuery: query
      });
    }

    if (suggestions.length === 0) return null;
    return GeminiScannerService.sanitizeSuggestions({
      summary: `Parsed ${suggestions.length} visual suggestions from Markdown table.`,
      suggestions
    }, maxLines, maxSuggestions);
  }

  static parseMarkdownSuggestions(text, maxLines = Infinity, maxSuggestions = 25) {
    const lines = text.split(/\r?\n/);
    const items = [];
    let currentItem = null;
    let summary = "";

    const hasNumbered = lines.some(l => /^\s*(?:#{1,4}\s*)?(?:Suggestion\s*)?\d+[.)]\s+/i.test(l.trim()));

    const isPropertyLine = (line) => {
      return /^[-*]?\s*(?:\*\*)?(?:Line(?: Number)?|Section|Heading|Visual Concept|Concept|Image Title|Title|Visual Type|Type|Category|Clinical Rationale|Rationale|Why|Description|DuckDuckGo(?: Search)? Query|Search Query|Recommended Query|Query)(?:\*\*)?\s*[:\-–—]/i.test(line);
    };

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine.trim();
      if (!line) continue;

      if (!summary && (line.toLowerCase().startsWith("summary:") || line.toLowerCase().startsWith("### summary") || line.toLowerCase().startsWith("**summary**"))) {
        summary = line.replace(/^(?:###|\*\*|summary:?)\s*/i, "").replace(/\*\*$/, "").trim();
        continue;
      }

      if (hasNumbered) {
        const isNumbered = /^\s*(?:#{1,4}\s*)?(?:Suggestion\s*)?\d+[.)]\s+/i.test(line);
        if (isNumbered) {
          if (currentItem && currentItem.rawLines.length > 0) items.push(currentItem);
          currentItem = { rawLines: [line] };
          continue;
        }
        if (currentItem) {
          currentItem.rawLines.push(line);
        }
      } else {
        const isBullet = /^[-*]\s+/.test(line);
        const isProp = isPropertyLine(line);

        if (isBullet && !isProp) {
          if (currentItem && currentItem.rawLines.length > 0) items.push(currentItem);
          currentItem = { rawLines: [line] };
          continue;
        }
        if (currentItem) {
          currentItem.rawLines.push(line);
        } else if (isBullet || isProp) {
          currentItem = { rawLines: [line] };
        }
      }
    }
    if (currentItem && currentItem.rawLines.length > 0) {
      items.push(currentItem);
    }

    const suggestions = [];
    for (const item of items) {
      const joined = item.rawLines.join("\n");

      let lineNum = 1;
      const lMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Line|Line Number)\*\*|Line|Line Number)\s*[:\-–—]\s*(?:Line\s*|\[?L?)(\d+)\]?/i) ||
                     joined.match(/(?:\[L(\d+)\]|\bLine\s*(\d+)\b|\bL(\d+)\b)/i);
      if (lMatch) {
        lineNum = parseInt(lMatch[1] || lMatch[2] || lMatch[3], 10);
      }

      let heading = "General";
      const hMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Section|Heading)\*\*|Heading|Section)\s*[:\-–—]\s*([^\n\r*]+)/i);
      if (hMatch) {
        heading = hMatch[1].trim();
      } else {
        const firstLineHeader = item.rawLines[0].replace(/^\s*(?:#{1,4}\s*)?(?:\d+[.)]\s*|[-*]\s*)/, "").replace(/^\*\*|\*\*$/g, "").trim();
        if (firstLineHeader && !firstLineHeader.toLowerCase().includes("concept")) {
          heading = firstLineHeader.split(/[-–—:]/)[0].trim();
        }
      }

      let concept = "";
      const cMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Visual Concept|Concept|Image Title|Title)\*\*|Visual Concept|Concept|Image Title|Title)\s*[:\-–—]\s*([^\n\r*]+)/i);
      if (cMatch) {
        concept = cMatch[1].trim();
      } else {
        const firstBold = item.rawLines[0].match(/\*\*([^*]+)\*\*/);
        if (firstBold && !/^(?:heading|section|line|type|visual type|rationale|query)$/i.test(firstBold[1].trim())) {
          concept = firstBold[1].trim();
        } else {
          const cleanedFirst = item.rawLines[0].replace(/^\s*(?:#{1,4}\s*)?(?:\d+[.)]\s*|[-*]\s*)/, "").replace(/[*_`]/g, "").trim();
          if (cleanedFirst) concept = cleanedFirst;
        }
      }

      let visualType = "diagram";
      const tMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Visual Type|Type|Category)\*\*|Visual Type|Type|Category)\s*[:\-–—]\s*([^\n\r*]+)/i);
      if (tMatch) {
        visualType = GeminiScannerService.normalizeVisualType(tMatch[1].trim());
      }

      let rationale = "High-yield visual gap for clinical understanding and exam revision.";
      const rMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Rationale|Clinical Rationale|Why)\*\*|Rationale|Clinical Rationale|Why)\s*[:\-–—]\s*([^\n\r]+)/i);
      if (rMatch) {
        rationale = rMatch[1].trim();
      }

      let query = "";
      const qMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:DuckDuckGo Search Query|DuckDuckGo Query|Search Query|Recommended Query|Query)\*\*|DuckDuckGo Search Query|DuckDuckGo Query|Search Query|Recommended Query|Query)\s*[:\-–—]\s*[`'"]?([^\n\r`'"]+)[`'"]?/i);
      if (qMatch) {
        query = qMatch[1].trim();
      }

      if (!concept && !query && heading === "General") continue;
      if (!concept) concept = query || heading;
      if (!query) query = concept + " " + (visualType === "diagram" ? "anatomy diagram" : visualType);

      query = query.replace(/^[`'"]+|[`'"]+$/g, "").trim();

      suggestions.push({
        heading: heading || "General",
        line: isNaN(lineNum) || lineNum < 1 ? 1 : (maxLines !== Infinity && lineNum > maxLines ? Math.min(lineNum, maxLines) : lineNum),
        visualConcept: concept,
        visualType,
        rationale,
        recommendedQuery: query
      });
    }

    if (suggestions.length === 0) return null;
    return GeminiScannerService.sanitizeSuggestions({
      summary: summary || `Identified ${suggestions.length} visual suggestions from Gemini notes.`,
      suggestions
    }, maxLines, maxSuggestions);
  }

  static parseGeminiResponse(rawText, maxLines = Infinity, maxSuggestions = 25) {
    if (!rawText || !rawText.trim()) {
      throw new Error("Clipboard or input is empty. Copy Gemini's response and try again.");
    }
    const clean = rawText.trim();

    // Strategy 1: JSON within ```json codeblock or direct JSON / array
    const jsonCandidates = [];
    const jsonBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      jsonCandidates.push(jsonBlockMatch[1].trim());
    }
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonCandidates.push(clean.slice(firstBrace, lastBrace + 1));
    }
    const firstBracket = clean.indexOf("[");
    const lastBracket = clean.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      jsonCandidates.push(clean.slice(firstBracket, lastBracket + 1));
    }

    for (const cand of jsonCandidates) {
      const sanitized = cand.replace(/,\s*([\]}])/g, "$1");
      for (const str of [cand, sanitized]) {
        try {
          let parsed = JSON.parse(str);
          if (Array.isArray(parsed)) parsed = { suggestions: parsed };
          if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
            return GeminiScannerService.sanitizeSuggestions(parsed, maxLines, maxSuggestions);
          }
        } catch (_) {
          try {
            const cleanedStr = str.replace(/[\u0000-\u001F]+/g, (m) => (m === '\n' || m === '\r' || m === '\t') ? ' ' : '');
            let parsed = JSON.parse(cleanedStr);
            if (Array.isArray(parsed)) parsed = { suggestions: parsed };
            if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
              return GeminiScannerService.sanitizeSuggestions(parsed, maxLines, maxSuggestions);
            }
          } catch (_) {}
          const lb = str.lastIndexOf("}");
          if (lb !== -1) {
            const candidate = str.slice(0, lb + 1);
            for (const suffix of ["]}", "}", "]"]) {
              try {
                let parsed = JSON.parse(candidate + suffix);
                if (Array.isArray(parsed)) parsed = { suggestions: parsed };
                if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
                  return GeminiScannerService.sanitizeSuggestions(parsed, maxLines, maxSuggestions);
                }
              } catch (_) {}
            }
          }
        }
      }
    }

    // Strategy 2: Markdown Table
    const tableSuggestions = GeminiScannerService.parseMarkdownTable(clean, maxLines, maxSuggestions);
    if (tableSuggestions && tableSuggestions.suggestions.length > 0) {
      return tableSuggestions;
    }

    // Strategy 3: Markdown List (Numbered or Bulleted)
    const mdSuggestions = GeminiScannerService.parseMarkdownSuggestions(clean, maxLines, maxSuggestions);
    if (mdSuggestions && mdSuggestions.suggestions.length > 0) {
      return mdSuggestions;
    }

    // Strategy 4: Regex extraction of JSON-like object blocks { ... }
    const blockSuggestions = [];
    const blockRegex = /\{([^{}]+)\}/g;
    let bMatch;
    while ((bMatch = blockRegex.exec(clean)) !== null) {
      const block = bMatch[1];
      const hMatch = block.match(/(?:"|'|)\b(?:heading|section)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const lMatch = block.match(/(?:"|'|)\b(?:line|l)\b(?:"|'|)\s*:\s*"?\[?L?(\d+)\]?"?/i);
      const cMatch = block.match(/(?:"|'|)\b(?:visualConcept|concept|title)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const tMatch = block.match(/(?:"|'|)\b(?:visualType|type|category)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const rMatch = block.match(/(?:"|'|)\b(?:rationale|reason|description)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const qMatch = block.match(/(?:"|'|)\b(?:recommendedQuery|query|searchQuery)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      if ((cMatch || hMatch) && (qMatch || cMatch)) {
        blockSuggestions.push({
          heading: hMatch ? hMatch[1] : "General",
          line: lMatch ? parseInt(lMatch[1], 10) : 1,
          visualConcept: cMatch ? cMatch[1] : (hMatch ? hMatch[1] : "Visual Diagram"),
          visualType: GeminiScannerService.normalizeVisualType(tMatch ? tMatch[1] : "diagram"),
          rationale: rMatch ? rMatch[1] : "High-yield visual gap for clinical understanding and exam revision.",
          recommendedQuery: qMatch ? qMatch[1] : (cMatch ? cMatch[1] + " diagram" : "medical diagram")
        });
      }
    }
    if (blockSuggestions.length > 0) {
      return GeminiScannerService.sanitizeSuggestions({
        summary: `Parsed ${blockSuggestions.length} visual suggestions from Gemini.`,
        suggestions: blockSuggestions
      }, maxLines, maxSuggestions);
    }

    throw new Error("Could not find visual suggestions in the Gemini response. Please ensure you copied Gemini's complete output.");
  }

  static _parseJsonSafely(rawText, maxSuggestions = 25) {
    return GeminiScannerService.parseGeminiResponse(rawText, Infinity, maxSuggestions);
  }

  static buildAltGPrompt(noteTitle, noteContent, targetCount = 25) {
    const allLines = noteContent.split(/\r?\n/);
    const totalLines = allLines.length;

    let totalImagesFound = 0;
    allLines.forEach((l) => {
      totalImagesFound += (l.match(/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/g) || []).length;
    });

    const fullNumberedText = allLines.map((l, i) => `[L${i + 1}] ${l}`).join("\n");

    return `You are an expert MBBS medical educator with deep knowledge of:
- Clinical Surgery (Bailey & Love, SRB, Schwartz)
- Clinical Medicine (Davidson, Harrison, Kumar & Clark)
- Anatomy (Gray's, Snell, BD Chaurasia)
- Pathology / HPE (Robbins, Harsh Mohan)
- Radiology (pathognomonic signs, pattern recognition)
- Physiology (Guyton, Ganong — flowcharts, graphs)
- Pharmacology (drug mechanism diagrams)
- Embryology (Moore, Langman — developmental diagrams)

Your task: Read the ENTIRE, UNABRIDGED medical note below from top to bottom.
Identify every significant location where a medical student needs a visual image for exam/viva retention.

━━ VISUAL CATEGORIES ━━
1. ANATOMY/DIAGRAM: Surgical triangles, fascial layers, compartments, canals, sheaths, nerve/vascular supply, cross-sections, lymph drainage, organ topography
2. RADIOLOGY: Pathognomonic X-ray/CT/MRI/USG/barium signs (bird-beak, coffee-bean, whirl sign, target sign, double-bubble, step-ladder fluid levels, apple-core, EUS 5-layer wall)
3. HPE/HISTOLOGY: Microscopic hallmarks (Reed-Sternberg, Psammoma bodies, Orphan Annie, Signet-ring cells, Correa cascade, H&E patterns)
4. CLINICAL/SURGICAL: Operative steps, repair layers, incisions, physical signs, examination findings, reconstruction loops (Billroth, Roux-en-Y, Whipple, Graham patch)
5. CRITERIA/SCORING: Diagnostic criteria tables, scoring systems (Alvarado, Revised Atlanta, Child-Pugh, MELD, Forrest, Daintree Johnson, Lauren, Borrmann, Siewert, Todani, Hinchey, Ranson)
6. EMBRYOLOGY/PHYSIOLOGY: Developmental rotations, descent, physiological curves, action potentials, hormonal feedback

━━ STRICT RULES ━━
- Scan the ENTIRE note thoroughly. Do NOT skip any section.
- Use the [L<number>] prefix to report the EXACT line number where each visual opportunity exists.
- CRITICAL: Keep recommendedQuery SIMPLE, CLEAN, and CONCISE (strictly 3 to 5 clear keywords, e.g. 'Whipple procedure labeled diagram', 'Double bubble sign X-ray', 'Passaro triangle diagram', 'Grey Turner Cullen sign', 'Pancreas blood supply diagram'). Avoid long, convoluted 8-12 word queries that clutter image search engines.
- Recommend clean, simple textbook illustrations, anatomical diagrams, and pathognomonic clinical/radiological spotters rather than overly dense, obscure micro-cellular schematics (optimized for DuckDuckGo image search).
- visualType must be one of: "diagram", "radiology", "histology", "clinical", "criteria", "embryology".
- Provide at most ${targetCount} high-yield suggestions, ordered chronologically by ascending line number [L<number>].

━━ PREFERRED OUTPUT FORMAT ━━
Output valid JSON (or a clearly formatted markdown list) with your visual recommendations:
\`\`\`json
{
  "summary": "One sentence overview of the note topic and visual opportunities",
  "suggestions": [
    {
      "heading": "Section heading from note",
      "line": 42,
      "visualConcept": "Specific image title",
      "visualType": "diagram",
      "rationale": "Why this visual is high-yield for MBBS exams (2 sentences)",
      "recommendedQuery": "Whipple procedure labeled diagram"
    }
  ]
}
\`\`\`
If you output a markdown list instead of JSON, format each item like this:
1. **Heading**: [Section Name]
   - **Line**: [L42]
   - **Concept**: [Image Title]
   - **Type**: [diagram|radiology|histology|clinical|criteria|embryology]
   - **Rationale**: [Educational explanation]
   - **Query**: [3 to 5 clear search keywords, e.g. 'Whipple procedure labeled diagram']

Select the ${targetCount} most high-yield concepts for MBBS/NEET-PG exams, and output all suggestions strictly in ascending order of line number [L<number>].

Note Title: "${noteTitle}"
Total Lines: ${totalLines}
Existing Images: ${totalImagesFound}

━━ COMPLETE UNABRIDGED NOTE (all lines with original line numbers) ━━
${fullNumberedText}`;
  }

  async scanNote(noteTitle, noteContent, maxSuggestions = 20, onProgress = null) {
    if (!this.apiKey) {
      throw new Error(
        "Gemini API key is missing. Please enter your API key in Settings → Medical Image Finder → Gemini API."
      );
    }

    let submittedContent = noteContent;
    let truncationNote = "";
    if (submittedContent.length > 60000) {
      submittedContent = submittedContent.slice(0, 60000);
      truncationNote = " (scanned first 60,000 characters)";
    }

    const allLines = submittedContent.split(/\r?\n/);
    const totalLines = allLines.length;

    let totalImagesFound = 0;
    allLines.forEach((l) => {
      totalImagesFound += (l.match(/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/g) || []).length;
    });

    if (onProgress) onProgress("Uploading & analyzing note (" + submittedContent.length.toLocaleString() + " chars, " + totalLines + " lines)...");

    const fullNumberedText = allLines.map((l, i) => `[L${i + 1}] ${l}`).join("\n");

    const systemPrompt = `You are an expert MBBS medical educator. Find visual opportunities across note. Line prefix is [L<number>]. CRITICAL: Keep recommendedQuery SIMPLE, CLEAN, and CONCISE (strictly 3 to 5 clear keywords, e.g. 'Whipple procedure labeled diagram', 'Double bubble sign X-ray', 'Passaro triangle diagram', 'Grey Turner Cullen sign', 'Pancreas blood supply diagram'). Recommend clean textbook illustrations and pathognomonic spotters. Output valid JSON with summary and suggestions array containing heading, line, visualConcept, visualType, rationale, recommendedQuery strictly ordered by ascending line number.`;
    const userPrompt = `Note Title: "${noteTitle}"\nTotal Lines: ${totalLines}\nExisting Images: ${totalImagesFound}\n\n${fullNumberedText}`;

    const modelsToTry = [
      this.model,
      "gemini-2.5-flash",
      "gemini-1.5-flash",
      "gemini-2.0-flash",
      "gemini-2.5-pro"
    ];
    const uniqueModels = Array.from(new Set(modelsToTry.filter(Boolean)));

    const ATTEMPT_TIMEOUT_MS = 180000;
    let response, lastErr, successfulModel = this.model;

    for (const curModel of uniqueModels) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        curModel
      )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

      const payload = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: 8192
        }
      });

      const retryDelays = [4000, 10000];
      let modelOk = false;

      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        let timerId;
        try {
          const apiCall = requestUrl({
            url: endpoint,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload
          });
          const timeout = new Promise((_, rej) => {
            timerId = setTimeout(() => rej(new Error("TIMEOUT")), ATTEMPT_TIMEOUT_MS);
          });
          response = await Promise.race([apiCall, timeout]);
          successfulModel = curModel;
          modelOk = true;
          break;
        } catch (err) {
          lastErr = err;
          const status = err && (err.status || err.statusCode || 0);
          if (status === 503 || status === 529) {
            if (attempt < retryDelays.length) {
              await new Promise(r => setTimeout(r, retryDelays[attempt]));
              continue;
            }
            break;
          }
          if (status === 404) break;
          if (status === 429) {
            if (attempt < retryDelays.length) {
              await new Promise(r => setTimeout(r, retryDelays[attempt] * 2));
              continue;
            }
            break;
          }
          break;
        } finally {
          if (timerId) clearTimeout(timerId);
        }
      }

      if (modelOk) break;
    }

    if (!response) {
      throw new Error("Gemini API error across tested models: " + safeError(lastErr));
    }

    const data = response.json;
    const candidate = data && data.candidates && data.candidates[0];
    if (!candidate || candidate.finishReason === "SAFETY" || !candidate.content) {
      throw new Error("Gemini returned no candidate response or content was blocked.");
    }
    const rawText = candidate.content.parts
      ? candidate.content.parts.map(p => p.text || "").join("")
      : "";
    if (!rawText || !rawText.trim()) throw new Error("Gemini returned empty text.");

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawText.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    } catch (_) {
      parsedJson = GeminiScannerService.parseGeminiResponse(rawText, totalLines, maxSuggestions);
    }

    if (!parsedJson || !Array.isArray(parsedJson.suggestions) || parsedJson.suggestions.length === 0) {
      throw new Error("Gemini output missing valid suggestions array.");
    }

    for (const s of parsedJson.suggestions) {
      if (typeof s.recommendedQuery !== "string" || !s.recommendedQuery.trim()) {
        throw new Error("Invalid recommendedQuery in suggestion");
      }
      const lineMatch = String(s.line !== undefined ? s.line : "").match(/\d+/);
      const lineNum = lineMatch ? parseInt(lineMatch[0], 10) : NaN;
      if (isNaN(lineNum) || lineNum < 1 || lineNum > totalLines) {
        throw new Error("Suggestion line out of range");
      }
      s.line = lineNum;
    }

    const sanitized = GeminiScannerService.sanitizeSuggestions(parsedJson, totalLines, maxSuggestions);

    if (successfulModel && successfulModel !== this.model && this.plugin && this.plugin.settings) {
      this.plugin.settings.geminiModel = successfulModel;
      this.plugin.saveSettings().catch(() => {});
    }

    return {
      summary: (sanitized.summary || `Scanned note (${totalLines} lines) with Gemini.`) + truncationNote,
      existingImages: totalImagesFound,
      suggestions: sanitized.suggestions
    };
  }
}


class GeminiResponseImportModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mif-preview-modal");

    this.titleEl.setText("📥 Import Gemini Response");

    contentEl.createEl("p", {
      text: "Paste the response from your local Gemini app (Alt+G) below, or click '📋 Paste from Clipboard'. Accepts both JSON and Markdown formats.",
      cls: "mif-scan-hero-desc"
    });

    const textarea = contentEl.createEl("textarea");
    textarea.placeholder = "Paste Gemini's output here (JSON or Markdown list)...";
    textarea.rows = 14;
    textarea.style.width = "100%";
    textarea.style.boxSizing = "border-box";
    textarea.style.fontFamily = "var(--font-monospace)";
    textarea.style.fontSize = "12px";
    textarea.style.padding = "10px";
    textarea.style.borderRadius = "var(--radius-s)";
    textarea.style.border = "1px solid var(--background-modifier-border)";
    textarea.style.background = "var(--background-primary)";
    textarea.style.color = "var(--text-normal)";

    readFromClipboard().then(clip => {
      if (clip && (clip.includes("suggestions") || clip.includes("[L") || clip.includes("Heading") || clip.includes("Query") || clip.includes("Concept") || clip.includes("|"))) {
        textarea.value = clip;
      } else if (this.plugin.settings.lastImportedGeminiResponse) {
        textarea.value = this.plugin.settings.lastImportedGeminiResponse;
      }
    }).catch(() => {
      if (this.plugin.settings.lastImportedGeminiResponse) {
        textarea.value = this.plugin.settings.lastImportedGeminiResponse;
      }
    });

    const actions = contentEl.createDiv({ cls: "mif-modal-actions" });

    const pasteBtn = actions.createEl("button", {
      text: "📋 Paste from Clipboard",
      cls: "mif-btn mif-btn-copy"
    });
    pasteBtn.onclick = async () => {
      try {
        const clip = await readFromClipboard();
        if (!clip || !clip.trim()) {
          new Notice("Clipboard is empty.");
          return;
        }
        textarea.value = clip;
      } catch (err) {
        new Notice(`Could not read clipboard: ${safeError(err)}`);
      }
    };

    const importBtn = actions.createEl("button", {
      text: "⚡ Import & Show Visual Cards",
      cls: "mif-btn mif-btn-insert"
    });
    importBtn.onclick = () => {
      const raw = textarea.value;
      if (!raw || !raw.trim()) {
        new Notice("Please paste Gemini's response first.");
        return;
      }
      try {
        const lineCount = this.view.scanContext?.editor?.lineCount() || Infinity;
        const targetCount = this.plugin.settings.geminiMaxSuggestions || 25;
        const parsed = GeminiScannerService.parseGeminiResponse(raw, lineCount, targetCount);
        this.view.applyScanResults(parsed, raw);
        this.close();
        new Notice(`Imported ${parsed.suggestions.length} visual suggestions!`);
      } catch (err) {
        new Notice(`Import failed: ${safeError(err)}`);
      }
    };

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "mif-btn"
    });
    cancelBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}


class ImagePreviewModal extends Modal {
  constructor(app, plugin, item, view = null) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.view = view;
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
    img.title = `${this.item.title}\nDouble-click to open website in browser`;

    const handleDblClick = (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      const targetUrl = this.item.sourceUrl || this.item.imageUrl;
      if (openExternalUrl(targetUrl)) {
        new Notice(`🌐 Opening source in browser: ${this.item.domain || "Web"}`);
      }
    };
    img.ondblclick = handleDblClick;
    imgContainer.ondblclick = handleDblClick;

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
    this.plugin.bindAction(copyBtn, this.item, "copy");
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      copyBtn.setText("Copying...");
      try {
        await this.plugin.copyImageToClipboard(this.item);
        this.close();
      } catch (err) {
        new Notice(`Failed to copy: ${safeError(err)}`);
      } finally {
        copyBtn.disabled = false;
        copyBtn.setText("📋 Copy image to clipboard");
      }
    };

    const insertBtn = actions.createEl("button", {
      text: "📥 Save & insert into note",
      cls: "mif-btn mif-btn-insert"
    });
    this.plugin.bindAction(insertBtn, this.item, "insert");
    insertBtn.onclick = async () => {
      insertBtn.disabled = true;
      insertBtn.setText("Inserting...");
      try {
        await this.plugin.saveAndInsertImage(this.item);
        if (this.view && this.view.scanContext && this.view.scanContext.file === this.item.targetContext?.file) {
          this.view.scanContext.content = this.item.targetContext?.editor ? this.item.targetContext.editor.getValue() : this.view.scanContext.content;
        }
        if (this.view && this.view.searchTargetContext && this.view.searchTargetContext.file === this.item.targetContext?.file) {
          this.view.searchTargetContext.content = this.item.targetContext?.editor ? this.item.targetContext.editor.getValue() : this.view.searchTargetContext.content;
        }
        if (this.view && this.item.searchOriginSuggestionIndex != null) {
          this.view.insertedSuggestionIndices.add(this.item.searchOriginSuggestionIndex);
          this.view.lastActiveScannerIndex = this.item.searchOriginSuggestionIndex;
          this.view.currentTab = "scan";
        }
        if (this.view) this.view.render();
        this.close();
      } catch (err) {
        new Notice(`Failed to insert: ${safeError(err)}`);
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
      const targetUrl = this.item.sourceUrl || this.item.imageUrl;
      if (openExternalUrl(targetUrl)) {
        new Notice(`🌐 Opening source in browser: ${this.item.domain || "Web"}`);
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
class BatchImageReviewModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.suggestions = (view.scanResults?.suggestions || []).map((s, idx) => ({ ...s, _idx: idx }));
    this.scanContext = view.scanContext;
    this.reviewItems = [];
    this.currentProviderId = this.plugin.settings.defaultProvider || "duckduckgo";
    this.isInserting = false;
    this.isFetchingAll = false;
    this.insertBtn = null;
    this.selectionCount = null;
  }

  getProviderDisplayName(id) {
    switch (id) {
      case "brightdata": return "Bright Data (Google Images)";
      case "serpapi": return "Google Images (SerpApi)";
      case "brave": return "Brave Search";
      case "google_cse": return "Google CSE";
      case "wikimedia": return "Wikimedia";
      case "duckduckgo":
      default: return "DuckDuckGo";
    }
  }

  updateFooter() {
    let totalImages = 0;
    const selectedRows = this.reviewItems.filter(r => r.included && r.items.length > 0);
    selectedRows.forEach(r => {
      const count = (Array.isArray(r.selectedIndices) && r.selectedIndices.length > 0)
        ? r.selectedIndices.length
        : (r.selectedIdx != null ? 1 : 0);
      totalImages += count;
    });

    if (this.selectionCount) {
      this.selectionCount.setText(`${totalImages} image${totalImages === 1 ? '' : 's'} (${selectedRows.length} of ${this.reviewItems.length} topics) selected`);
    }
    if (this.insertBtn) {
      this.insertBtn.setText(`📥 Insert Selected (${totalImages})`);
      this.insertBtn.disabled = totalImages === 0 || this.isInserting;
    }
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mif-batch-modal");
    if (this.modalEl) this.modalEl.addClass("mif-batch-modal-window");

    this.titleEl.setText("⚡ Fast Batch Image Review & Integration");

    if (!this.suggestions.length) {
      contentEl.createEl("p", { text: "No suggestions available for batch insertion." });
      return;
    }

    // Header info & Provider Selector Toolbar
    const topBar = contentEl.createDiv({ cls: "mif-batch-top-bar" });
    const desc = topBar.createEl("p", {
      text: `Review visual matches for all ${this.suggestions.length} suggestions. Choice #1 is pre-selected; scroll horizontally to select 1 or more images per topic for batch integration.`,
      cls: "mif-scan-hero-desc"
    });
    desc.style.margin = "0 0 6px 0";

    const toolbar = topBar.createDiv({ cls: "mif-batch-toolbar" });
    toolbar.createSpan({ cls: "mif-batch-toolbar-label", text: "🔍 Search Engine:" });

    const providerSelect = toolbar.createEl("select", { cls: "mif-batch-provider-select" });
    const providerOptions = [
      { id: "duckduckgo", label: "DuckDuckGo (Free / No Key)" },
      { id: "brightdata", label: `Bright Data Google Images ${this.plugin.settings.brightDataApiKey ? "✓" : "(5K Free/Mo)"}` },
      { id: "serpapi", label: `SerpApi Google Images ${this.plugin.settings.serpApiKey ? "✓" : "(Requires Key)"}` },
      { id: "brave", label: `Brave Search ${this.plugin.settings.braveApiKey ? "✓" : "(Requires Key)"}` },
      { id: "google_cse", label: `Google CSE ${this.plugin.settings.googleApiKey ? "✓" : "(Requires Key)"}` },
      { id: "wikimedia", label: "Wikimedia Commons (Free)" }
    ];
    providerOptions.forEach(opt => {
      const el = providerSelect.createEl("option", { text: opt.label, value: opt.id });
      if (opt.id === this.currentProviderId) el.selected = true;
    });

    const refreshAllBtn = toolbar.createEl("button", {
      cls: "mif-btn mif-btn-refresh-all",
      text: "🔄 Re-search All with Engine"
    });

    providerSelect.onchange = () => {
      this.currentProviderId = providerSelect.value;
      new Notice(`Switched engine to ${this.getProviderDisplayName(this.currentProviderId)}`);
    };

    refreshAllBtn.onclick = () => {
      this.fetchAllCandidates(progressBar, progressLabel, progressContainer, true);
    };

    // Progress Bar
    const progressContainer = contentEl.createDiv({ cls: "mif-batch-progress-box" });
    const progressLabel = progressContainer.createDiv({ cls: "mif-batch-progress-label", text: "🔍 Searching images..." });
    const progressBar = progressContainer.createEl("progress", { cls: "mif-batch-progress-bar" });
    progressBar.max = this.suggestions.length;
    progressBar.value = 0;

    // Scrollable List Container
    const listContainer = contentEl.createDiv({ cls: "mif-batch-list-container" });

    // Sticky Responsive Footer
    const footer = contentEl.createDiv({ cls: "mif-batch-footer" });
    const leftFooter = footer.createDiv({ cls: "mif-batch-footer-left" });
    this.selectionCount = leftFooter.createSpan({ cls: "mif-batch-counter", text: "0 selected" });
    const selectAllBtn = leftFooter.createEl("button", { cls: "mif-link-btn", text: "Select All" });
    const deselectAllBtn = leftFooter.createEl("button", { cls: "mif-link-btn", text: "Deselect All" });

    const rightFooter = footer.createDiv({ cls: "mif-batch-footer-right mif-modal-actions" });
    const cancelBtn = rightFooter.createEl("button", { cls: "mif-btn", text: "Cancel" });
    this.insertBtn = rightFooter.createEl("button", { cls: "mif-btn mif-btn-insert mif-batch-footer-insert-btn", text: "📥 Insert Selected" });
    this.insertBtn.disabled = true;

    cancelBtn.onclick = () => this.close();

    selectAllBtn.onclick = () => {
      this.reviewItems.forEach((r) => {
        if (r.items.length > 0) {
          r.included = true;
          if (!Array.isArray(r.selectedIndices) || r.selectedIndices.length === 0) {
            r.selectedIndices = [0];
            r.selectedIdx = 0;
          }
        }
      });
      this.renderReviewCards(listContainer);
      this.updateFooter();
    };

    deselectAllBtn.onclick = () => {
      this.reviewItems.forEach((r) => {
        r.included = false;
        r.selectedIndices = [];
      });
      this.renderReviewCards(listContainer);
      this.updateFooter();
    };

    this.insertBtn.onclick = async () => {
      if (this.isInserting) return;
      this.isInserting = true;
      this.insertBtn.disabled = true;
      this.insertBtn.setText("⏳ Inserting...");

      const selected = this.reviewItems.filter(r => r.included && r.items.length > 0);
      const jobs = [];
      for (const r of selected) {
        const chosenIndices = (Array.isArray(r.selectedIndices) && r.selectedIndices.length > 0)
          ? r.selectedIndices
          : [r.selectedIdx || 0];
        for (let subIdx = 0; subIdx < chosenIndices.length; subIdx++) {
          const cIdx = chosenIndices[subIdx];
          const item = r.items[cIdx];
          if (!item) continue;
          jobs.push({
            suggestionIndex: r.suggestion._idx,
            subIndex: subIdx,
            targetLine: r.suggestion.line,
            targetHeading: r.suggestion.heading,
            targetConcept: r.suggestion.visualConcept,
            targetQuery: r.suggestion.recommendedQuery,
            imageItem: {
              ...item,
              targetContext: this.scanContext,
              targetLine: r.suggestion.line,
              targetHeading: r.suggestion.heading,
              targetConcept: r.suggestion.visualConcept,
              targetQuery: r.suggestion.recommendedQuery,
              searchOriginSuggestionIndex: r.suggestion._idx
            }
          });
        }
      }

      try {
        progressContainer.style.display = "block";
        progressBar.max = jobs.length;
        progressBar.value = 0;
        const result = await this.plugin.batchInsertImages(jobs, (cur, total) => {
          progressBar.value = cur;
          progressLabel.setText(`Inserting into note... (${cur}/${total})`);
        });

        const successful = result?.successfulIndices || new Set(jobs.map(j => j.suggestionIndex));
        for (const idx of successful) {
          this.view.insertedSuggestionIndices.add(idx);
        }
        if (this.scanContext) {
          this.scanContext.content = this.scanContext.editor.getValue();
        }
        this.view.render();
        const failedIndices = result?.failedIndices;
        if (failedIndices && failedIndices.size > 0) {
          this.reviewItems.forEach(r => {
            if (failedIndices.has(r.suggestion?._idx)) {
              r.included = false;
              r.error = "Failed to insert image into note.";
              this.updateCard(r);
            }
          });
          this.isInserting = false;
          this.updateFooter();
        } else {
          this.close();
        }
      } catch (err) {
        new Notice(`Batch insertion error: ${safeError(err)}`);
        this.isInserting = false;
        this.updateFooter();
      }
    };

    // Initialize review items
    this.reviewItems = this.suggestions.map(s => {
      const alreadyInserted = this.view.insertedSuggestionIndices.has(s._idx);
      return {
        suggestion: s,
        query: s.recommendedQuery,
        visualType: s.visualType || "diagram",
        items: [],
        selectedIndices: alreadyInserted ? [] : [0],
        selectedIdx: 0,
        included: !alreadyInserted,
        loading: true,
        error: null
      };
    });

    this.renderReviewCards(listContainer);
    await this.fetchAllCandidates(progressBar, progressLabel, progressContainer);
  }

  async fetchSingleItem(rItem, customProviderId = null, bypassCache = false) {
    if (this.isClosed) return;
    const providerId = customProviderId || this.currentProviderId;
    const provider = this.plugin.getProvider(providerId);
    rItem.loading = true;
    rItem.error = null;
    try {
      const effQuery = this.view.getEffectiveQuery(rItem.query, rItem.visualType);
      const results = await (this.plugin.searchWithCache
        ? this.plugin.searchWithCache(provider, effQuery, bypassCache)
        : normalizeResults(await provider.search(effQuery)));
      if (this.isClosed) return;
      const norm = this.plugin.searchWithCache ? results : normalizeResults(results);
      rItem.items = norm;
      rItem.loading = false;
      if (norm.length > 0) {
        const alreadyInserted = this.view.insertedSuggestionIndices?.has(rItem.suggestion?._idx);
        rItem.included = !alreadyInserted;
        rItem.selectedIndices = alreadyInserted ? [] : [0];
        rItem.selectedIdx = 0;
      } else {
        rItem.included = false;
        rItem.selectedIndices = [];
        rItem.selectedIdx = 0;
        rItem.error = `No images returned by ${this.getProviderDisplayName(providerId)}. Try different keywords or switch engine.`;
      }
    } catch (err) {
      if (this.isClosed) return;
      rItem.loading = false;
      rItem.error = safeError(err);
      rItem.included = false;
      rItem.selectedIndices = [];
    }
  }

  async fetchAllCandidates(progressBar, progressLabel, progressContainer, bypassCache = false) {
    if (this.isFetchingAll || this.isClosed) return;
    this.isFetchingAll = true;
    try {
      if (progressContainer) progressContainer.style.display = "block";
      if (progressBar) {
        progressBar.max = this.reviewItems.length;
        progressBar.value = 0;
      }

      const isDdg = this.currentProviderId === "duckduckgo";
      const delayMs = isDdg ? 900 : 250;

      for (let i = 0; i < this.reviewItems.length; i++) {
        if (this.isClosed) break;
        const item = this.reviewItems[i];
        item.loading = true;
        item.error = null;
        this.updateCard(item);

        if (progressLabel) progressLabel.setText(`Fetching images via ${this.getProviderDisplayName(this.currentProviderId)}... (${i + 1}/${this.reviewItems.length})`);
        await this.fetchSingleItem(item, null, bypassCache);
        if (this.isClosed) break;
        this.updateCard(item);
        if (progressBar) progressBar.value = i + 1;
        this.updateFooter();

        if (i < this.reviewItems.length - 1 && !this.isClosed) {
          await new Promise(res => setTimeout(res, delayMs));
        }
      }
    } finally {
      this.isFetchingAll = false;
      if (!this.isClosed) {
        if (progressContainer) progressContainer.style.display = "none";
        this.updateFooter();
      }
    }
  }

  renderReviewCards(container) {
    container.empty();
    this.reviewItems.forEach((r, idx) => {
      const card = container.createDiv({ cls: "mif-batch-card" });
      const cardId = r.suggestion?._idx !== undefined ? r.suggestion._idx : idx;
      card.id = `mif-batch-card-${cardId}`;
      this.populateCard(card, r);
    });
  }

  updateCard(rItem) {
    const cardId = rItem.suggestion?._idx !== undefined ? rItem.suggestion._idx : this.reviewItems.indexOf(rItem);
    const card = this.contentEl.querySelector(`#mif-batch-card-${cardId}`);
    if (card) {
      card.empty();
      this.populateCard(card, rItem);
      this.updateFooter();
    }
  }

  populateCard(card, r) {
    const s = r.suggestion;
    const headerRow = card.createDiv({ cls: "mif-batch-card-header" });

    const cb = headerRow.createEl("input", { type: "checkbox", cls: "mif-batch-checkbox" });
    cb.checked = r.included;
    cb.disabled = r.loading || r.items.length === 0;
    cb.onchange = () => {
      r.included = cb.checked;
      if (cb.checked) {
        if (!Array.isArray(r.selectedIndices) || r.selectedIndices.length === 0) {
          r.selectedIndices = [0];
          r.selectedIdx = 0;
          this.updateCard(r);
          return;
        }
      }
      this.updateCard(r);
      this.updateFooter();
    };

    const titleEl = headerRow.createSpan({ cls: "mif-batch-card-title" });
    titleEl.setText(`[L${s.line}] ${s.heading} — ${s.visualConcept}`);

    const badge = headerRow.createSpan({ cls: "mif-badge" });
    const selCount = (r.included && Array.isArray(r.selectedIndices)) ? r.selectedIndices.length : 0;
    const countText = r.items.length > 0 ? ` • ${r.items.length} options` : "";
    const selText = selCount > 1 ? ` (${selCount} selected)` : "";
    badge.setText(`${s.visualType || "diagram"}${countText}${selText}`);

    if (r.loading) {
      const loadBox = card.createDiv({ cls: "mif-batch-loading" });
      loadBox.setText(`⏳ Searching ${this.getProviderDisplayName(this.currentProviderId)}...`);
      return;
    }

    if (r.error || r.items.length === 0) {
      const errBox = card.createDiv({ cls: "mif-batch-error-box" });
      errBox.createDiv({
        cls: "mif-batch-no-results",
        text: r.error || "No images found."
      });

      // Individual Card Action Row for Retry & Custom Query
      const cardActions = errBox.createDiv({ cls: "mif-batch-card-actions" });
      const queryInput = cardActions.createEl("input", {
        type: "text",
        cls: "mif-batch-card-query-input",
        value: r.query
      });
      queryInput.placeholder = "Edit search query...";
      queryInput.onchange = () => {
        r.query = queryInput.value.trim();
      };

      // Dedicated Retry Button (never has mif-btn-insert class)
      const retryBtn = cardActions.createEl("button", {
        cls: "mif-btn mif-batch-card-retry",
        text: "🔄 Retry"
      });
      retryBtn.title = "Re-search using currently selected engine";
      retryBtn.onclick = async () => {
        r.query = queryInput.value.trim();
        await this.fetchSingleItem(r, null, true);
        this.updateCard(r);
        this.updateFooter();
      };

      // Dedicated SerpApi Button
      const serpBtn = cardActions.createEl("button", {
        cls: "mif-btn mif-batch-card-alt",
        text: "Try SerpApi"
      });
      serpBtn.title = "Search real Google Images using SerpApi";
      serpBtn.onclick = async () => {
        if (!this.plugin.settings.serpApiKey) {
          new Notice("SerpApi API Key is missing. Enter it in Settings → Medical Image Finder → SerpApi Key.", 6000);
          return;
        }
        r.query = queryInput.value.trim();
        await this.fetchSingleItem(r, "serpapi", true);
        this.updateCard(r);
        this.updateFooter();
      };

      // Dedicated Brave Button
      const braveBtn = cardActions.createEl("button", {
        cls: "mif-btn mif-batch-card-alt",
        text: "Try Brave"
      });
      braveBtn.title = "Search via Brave Search API";
      braveBtn.onclick = async () => {
        if (!this.plugin.settings.braveApiKey) {
          new Notice("Brave API Key is missing. Enter it in Settings → Medical Image Finder → Brave Key.", 6000);
          return;
        }
        r.query = queryInput.value.trim();
        await this.fetchSingleItem(r, "brave", true);
        this.updateCard(r);
        this.updateFooter();
      };

      // Dedicated Bright Data Button
      const bdBtn = cardActions.createEl("button", {
        cls: "mif-btn mif-batch-card-alt",
        text: "Try Bright Data"
      });
      bdBtn.title = "Search Google Images via Bright Data (5K free/mo)";
      bdBtn.onclick = async () => {
        if (!this.plugin.settings.brightDataApiKey) {
          new Notice("Bright Data API Key is missing. Enter it in Settings → Medical Image Finder → Bright Data Key.", 6000);
          return;
        }
        r.query = queryInput.value.trim();
        await this.fetchSingleItem(r, "brightdata", true);
        this.updateCard(r);
        this.updateFooter();
      };

      return;
    }

    // Success state: show candidate thumbnails with horizontal scroll
    const optionsRow = card.createDiv({ cls: "mif-batch-options-row" });

    // Smooth horizontal mouse-wheel scrolling
    optionsRow.addEventListener("wheel", (evt) => {
      if (evt.deltaY !== 0 && !evt.shiftKey) {
        optionsRow.scrollLeft += evt.deltaY;
        evt.preventDefault();
      }
    }, { passive: false });

    r.items.forEach((item, cIdx) => {
      const isSelected = r.included && Array.isArray(r.selectedIndices) && r.selectedIndices.includes(cIdx);
      const optEl = optionsRow.createDiv({
        cls: `mif-batch-thumb-option ${isSelected ? "is-selected" : ""}`
      });

      const img = optEl.createEl("img", { cls: "mif-batch-thumb-img" });
      img.src = item.thumbnailUrl || item.imageUrl;
      img.alt = item.title;
      optEl.title = `${item.title} (${item.domain || "Web"})\nClick to select/unselect • Double-click to open website in browser`;

      optEl.createSpan({
        cls: "mif-batch-choice-label",
        text: isSelected ? `✓ #${cIdx + 1}` : `#${cIdx + 1}`
      });

      // Single-click: toggle selection for this image (1 or more per query)
      optEl.onclick = (e) => {
        e.stopPropagation();
        if (e.detail > 1) return;
        if (!Array.isArray(r.selectedIndices)) {
          r.selectedIndices = (r.selectedIdx != null && r.included) ? [r.selectedIdx] : [];
        }
        const idxInSelected = r.selectedIndices.indexOf(cIdx);
        if (idxInSelected >= 0) {
          r.selectedIndices.splice(idxInSelected, 1);
          optEl.removeClass("is-selected");
          const lbl = optEl.querySelector(".mif-batch-choice-label");
          if (lbl) lbl.setText(`#${cIdx + 1}`);
        } else {
          r.selectedIndices.push(cIdx);
          r.selectedIndices.sort((a, b) => a - b);
          optEl.addClass("is-selected");
          const lbl = optEl.querySelector(".mif-batch-choice-label");
          if (lbl) lbl.setText(`✓ #${cIdx + 1}`);
        }

        r.selectedIdx = r.selectedIndices.length > 0 ? r.selectedIndices[0] : 0;
        if (r.selectedIndices.length > 0) {
          r.included = true;
          cb.checked = true;
        } else {
          r.included = false;
          cb.checked = false;
        }
        const updatedSel = r.included ? r.selectedIndices.length : 0;
        badge.setText(`${s.visualType || "diagram"} • ${r.items.length} options${updatedSel > 1 ? ` (${updatedSel} selected)` : ""}`);
        this.updateFooter();
      };

      // Double-click: open source website in browser
      optEl.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetUrl = item.sourceUrl || item.imageUrl;
        if (openExternalUrl(targetUrl)) {
          new Notice(`🌐 Opening source in browser: ${item.domain || "Web"}`);
        }
      };
    });

    // Individual Card Sub-bar (editable query + single retry + Try SerpApi + Try Brave)
    const cardActions = card.createDiv({ cls: "mif-batch-card-actions" });
    const queryInput = cardActions.createEl("input", {
      type: "text",
      cls: "mif-batch-card-query-input",
      value: r.query
    });
    queryInput.title = "Tweak query and click Retry if you want different images";
    queryInput.onchange = () => {
      r.query = queryInput.value.trim();
    };

    const retryBtn = cardActions.createEl("button", {
      cls: "mif-btn mif-batch-card-retry",
      text: "🔄 Re-search"
    });
    retryBtn.title = "Re-search images for this specific topic";
    retryBtn.onclick = async () => {
      r.query = queryInput.value.trim();
      await this.fetchSingleItem(r, null, true);
      this.updateCard(r);
      this.updateFooter();
    };

    const serpBtn = cardActions.createEl("button", {
      cls: "mif-btn mif-batch-card-alt",
      text: "Try SerpApi"
    });
    serpBtn.title = "Search real Google Images using SerpApi";
    serpBtn.onclick = async () => {
      if (!this.plugin.settings.serpApiKey) {
        new Notice("SerpApi API Key is missing. Enter it in Settings → Medical Image Finder → SerpApi Key.", 6000);
        return;
      }
      r.query = queryInput.value.trim();
      await this.fetchSingleItem(r, "serpapi", true);
      this.updateCard(r);
      this.updateFooter();
    };

    const braveBtn = cardActions.createEl("button", {
      cls: "mif-btn mif-batch-card-alt",
      text: "Try Brave"
    });
    braveBtn.title = "Search via Brave Search API";
    braveBtn.onclick = async () => {
      if (!this.plugin.settings.braveApiKey) {
        new Notice("Brave API Key is missing. Enter it in Settings → Medical Image Finder → Brave Key.", 6000);
        return;
      }
      r.query = queryInput.value.trim();
      await this.fetchSingleItem(r, "brave", true);
      this.updateCard(r);
      this.updateFooter();
    };

    const bdBtn = cardActions.createEl("button", {
      cls: "mif-btn mif-batch-card-alt",
      text: "Try Bright Data"
    });
    bdBtn.title = "Search Google Images via Bright Data (5K free/mo)";
    bdBtn.onclick = async () => {
      if (!this.plugin.settings.brightDataApiKey) {
        new Notice("Bright Data API Key is missing. Enter it in Settings → Medical Image Finder → Bright Data Key.", 6000);
        return;
      }
      r.query = queryInput.value.trim();
      await this.fetchSingleItem(r, "brightdata", true);
      this.updateCard(r);
      this.updateFooter();
    };
  }

  onClose() {
    this.isClosed = true;
    this.contentEl.empty();
  }
}
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
    this.currentTab = "search"; // "search" | "scan"
    this.scanResults = this.plugin.settings.lastScanResults || null;
    this.restoredFromMemory = !!this.scanResults;
    this.isScanning = false;
    this.scanErrorMessage = "";
    this.inlineQuickResults = new Map();
    this.inlineLoading = new Set();
    this.searchGeneration = 0;
    this.scanGeneration = 0;
    this.closed = false;
    this.waitingForGemini = false;
    this.copiedPromptNote = "";
    this.insertedSuggestionIndices = new Set();
    this.searchOriginSuggestionIndex = null;
    this.searchTargetHeading = null;
    this.lastActiveScannerIndex = null;
    this.scannerScrollTop = 0;
    this.searchScrollTop = 0;
    this._lastRenderedTab = null;
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
    this.closed = false;
    this.render();
  }

  async onClose() {
    this.closed = true;
    ++this.searchGeneration;
    ++this.scanGeneration;
    this.stopClipboardWatcher();
    this.inlineLoading.clear();
  }

  switchToSearchTab(query = null, filter = null, autoSearch = false) {
    if (this.currentTab === "scan" && this.contentEl) {
      this.scannerScrollTop = this.contentEl.scrollTop || 0;
    }
    this.currentTab = "search";
    if (filter) this.activeFilter = filter;
    if (query) {
      this.currentQuery = query;
      if (this.queryInput) this.queryInput.value = query;
    }
    this.render();
    if (autoSearch && query) {
      this.executeSearch(query);
    }
  }

  switchToScanTab(autoScan = false) {
    if (this.currentTab === "search" && this.contentEl) {
      this.searchScrollTop = this.contentEl.scrollTop || 0;
    }
    this.currentTab = "scan";
    this.render();
    if (autoScan && !this.scanResults && !this.isScanning) {
      this.executeNoteScan();
    }
  }


  startClipboardWatcher(initialPrompt) {
    this.stopClipboardWatcher();
    this.lastPromptCopied = (initialPrompt || "").trim();
    this.isWatchingClipboard = true;

    const setIntervalFn = (typeof window !== "undefined" && window.setInterval) ||
      (typeof setInterval !== "undefined" ? setInterval : null);

    if (setIntervalFn) {
      this.clipboardWatcherInterval = setIntervalFn(() => {
        this.checkClipboardForResponse();
      }, 2000);
      if (typeof this.clipboardWatcherInterval?.unref === "function") {
        this.clipboardWatcherInterval.unref();
      }
    }

    this.onWindowFocus = () => {
      if (this.waitingForGemini) {
        this.checkClipboardForResponse();
      }
    };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("focus", this.onWindowFocus);
    }
  }

  stopClipboardWatcher() {
    this.isWatchingClipboard = false;
    const clearIntervalFn = (typeof window !== "undefined" && window.clearInterval) ||
      (typeof clearInterval !== "undefined" ? clearInterval : null);

    if (this.clipboardWatcherInterval && clearIntervalFn) {
      clearIntervalFn(this.clipboardWatcherInterval);
      this.clipboardWatcherInterval = null;
    }
    if (this.onWindowFocus && typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("focus", this.onWindowFocus);
      this.onWindowFocus = null;
    }
  }

  async checkClipboardForResponse() {
    if (this.closed || !this.waitingForGemini) {
      this.stopClipboardWatcher();
      return;
    }
    try {
      const clip = await readFromClipboard();
      if (!clip || !clip.trim()) return;
      const clean = clip.trim();
      if (clean === this.lastPromptCopied || clean.length < 25) return;

      const looksLikeResponse = clean.includes("suggestions") ||
        clean.includes("[L") ||
        clean.includes("| Line") ||
        clean.includes("Visual Concept") ||
        clean.includes("DuckDuckGo") ||
        clean.includes("Search Query") ||
        /^\s*(?:#{1,4}\s*)?\d+[.)]\s+/m.test(clean) ||
        (clean.startsWith("{") && clean.includes("summary"));

      if (!looksLikeResponse) return;

      const lineCount = this.scanContext?.editor?.lineCount() || Infinity;
      const parsed = GeminiScannerService.parseGeminiResponse(clean, lineCount);
      if (parsed && parsed.suggestions && parsed.suggestions.length > 0) {
        this.stopClipboardWatcher();
        this.applyScanResults(parsed);
        new Notice(`Auto-detected Gemini response from clipboard! Rendered ${parsed.suggestions.length} visual cards.`, 6000);
      }
    } catch (_) {}
  }

  async runAutoPilotBatch() {
    if (this.isScanning || !this.scanResults || !this.scanResults.suggestions.length) {
      new Notice("No visual suggestions to insert.");
      return;
    }
    let target;
    try {
      target = this.plugin.captureTarget(this.scanContext);
    } catch (err) {
      new Notice(safeError(err));
      return;
    }

    const suggestions = this.scanResults.suggestions;
    const remaining = suggestions.filter((_, idx) => !this.insertedSuggestionIndices.has(idx));
    if (!remaining.length) {
      new Notice("All suggestions have already been inserted!");
      return;
    }

    new Notice(`🚀 Auto-Pilot: Fetching top image for ${remaining.length} suggestions...`, 6000);

    const jobs = [];
    const provider = this.plugin.getActiveProvider();

    for (let i = 0; i < suggestions.length; i++) {
      if (this.insertedSuggestionIndices.has(i)) continue;
      if (jobs.length > 0) {
        await new Promise(res => setTimeout(res, 750));
      }
      const s = suggestions[i];
      try {
        const effectiveQuery = this.getEffectiveQuery(s.recommendedQuery, s.visualType || "diagram");
        const results = await (this.plugin.searchWithCache
          ? this.plugin.searchWithCache(provider, effectiveQuery)
          : normalizeResults(await provider.search(effectiveQuery)));
        const norm = this.plugin.searchWithCache ? results : normalizeResults(results);
        if (norm.length > 0) {
          jobs.push({
            suggestionIndex: i,
            targetLine: s.line,
            targetHeading: s.heading,
            targetConcept: s.visualConcept,
            targetQuery: s.recommendedQuery,
            imageItem: {
              ...norm[0],
              targetContext: this.scanContext,
              targetLine: s.line,
              targetHeading: s.heading,
              targetConcept: s.visualConcept,
              targetQuery: s.recommendedQuery,
              searchOriginSuggestionIndex: i
            }
          });
        }
      } catch (err) {
        console.warn(`Auto-pilot search failed for "${s.visualConcept}":`, err);
      }
    }

    if (jobs.length === 0) {
      new Notice("No images found to insert.");
      return;
    }

    try {
      await this.plugin.batchInsertImages(jobs, (cur, total) => {
        new Notice(`Inserting ${cur} / ${total}...`, 2000);
      });
      for (const job of jobs) {
        this.insertedSuggestionIndices.add(job.suggestionIndex);
      }
      if (this.scanContext) {
        this.scanContext.content = this.scanContext.editor.getValue();
      }
      this.render();
    } catch (err) {
      new Notice(`Auto-pilot insertion failed: ${safeError(err)}`);
    }
  }

  async copyNotePromptForAltG() {
    let context;
    try {
      context = this.plugin.captureTarget();
    } catch (err) {
      new Notice(safeError(err));
      return;
    }
    const { file, content } = context;
    const title = file.basename;
    if (!content || !content.trim()) {
      new Notice("The active note is empty.");
      return;
    }

    this.scanContext = context;
    this.copiedPromptNote = title;
    this.waitingForGemini = true;

    const targetCount = this.plugin.settings.geminiMaxSuggestions || 25;
    const promptText = GeminiScannerService.buildAltGPrompt(title, content, targetCount);
    this.startClipboardWatcher(promptText);
    const copied = await copyToClipboard(promptText);
    if (copied) {
      new Notice("Copied! Press Alt+G, paste (Ctrl+V), and press Enter in Gemini.", 8000);
    } else {
      new Notice("Failed to copy automatically to clipboard. Please check permissions.", 5000);
    }
    this.render();
  }

  async importGeminiResponseFromClipboard() {
    try {
      const text = await readFromClipboard();
      if (!text || !text.trim()) {
        new Notice("Clipboard is empty. Copy Gemini's response, or use 'Import Gemini Response' to paste.", 5000);
        new GeminiResponseImportModal(this.app, this.plugin, this).open();
        return;
      }
      const lineCount = this.scanContext?.editor?.lineCount() || Infinity;
      const targetCount = this.plugin.settings.geminiMaxSuggestions || 25;
      const parsed = GeminiScannerService.parseGeminiResponse(text, lineCount, targetCount);
      await this.applyScanResults(parsed, text);
      new Notice(`Imported ${parsed.suggestions.length} visual suggestions!`, 5000);
    } catch (err) {
      new Notice(`Could not parse clipboard automatically: ${safeError(err)}. Opening paste window...`, 6000);
      new GeminiResponseImportModal(this.app, this.plugin, this).open();
    }
  }

  async applyScanResults(parsed, rawText = "") {
    this.scanResults = parsed;
    this.restoredFromMemory = false;
    this.scanErrorMessage = "";
    this.waitingForGemini = false;
    this.stopClipboardWatcher();
    this.inlineQuickResults.clear();
    this.inlineLoading.clear();
    try {
      this.plugin.settings.lastScanResults = parsed;
      if (rawText) this.plugin.settings.lastImportedGeminiResponse = rawText;
      this.plugin.settings.lastScannedNote = this.scanContext?.file?.basename || "";
      await this.plugin.saveSettings();
    } catch (_) {}
    this.render();
  }

  async clearScanMemory() {
    this.scanResults = null;
    this.restoredFromMemory = false;
    this.plugin.settings.lastScanResults = null;
    this.plugin.settings.lastImportedGeminiResponse = "";
    this.plugin.settings.lastScannedNote = "";
    this.insertedSuggestionIndices.clear();
    try {
      await this.plugin.saveSettings();
    } catch (_) {}
    this.render();
    new Notice("Cleared visual audit memory. Ready for fresh note scan.");
  }

  async jumpToLine(line) {
    try {
      const target = this.plugin.captureTarget(this.scanContext, line);
      await this.plugin.app.workspace.revealLeaf(target.view.leaf);
      target.editor.setCursor(target.position);
      target.editor.scrollIntoView({ from: target.position, to: target.position }, true);
      new Notice('Navigated to line ' + line);
    } catch (err) { new Notice(safeError(err)); }
  }

  async executeNoteScan() {
    if (this.isScanning || this.closed) return;
    let context;
    try { context = this.plugin.captureTarget(); }
    catch (err) { new Notice(safeError(err)); return; }
    const { file, content } = context;
    const title = file.basename;

    if (!content || !content.trim()) {
      new Notice("The active note is empty.");
      return;
    }

    const backend = this.plugin.settings.aiBackend || 'gemini';

    if (backend === 'gemini' && !this.plugin.settings.geminiApiKey) {
      new Notice(
        "Please enter your Gemini API key in Settings → Medical Image Finder → Gemini API.",
        8000
      );
      this.scanErrorMessage =
        "Gemini API key is required. Open Settings → Medical Image Finder → Gemini API Key.";
      this.render();
      return;
    }

    if (backend === 'groq' && !this.plugin.settings.groqApiKey) {
      new Notice(
        "Please enter your Groq API key in Settings → Medical Image Finder → Groq API Key.",
        8000
      );
      this.scanErrorMessage =
        "Groq API key is required. Open Settings → Medical Image Finder → Groq API Key.";
      this.render();
      return;
    }

    if (backend === 'openrouter' && !this.plugin.settings.openAiApiKey) {
      new Notice(
        "Please enter your API key in Settings → Medical Image Finder → OpenRouter / Free LLMs.",
        8000
      );
      this.scanErrorMessage =
        "OpenRouter / Free LLM API key is required. Open Settings → Medical Image Finder.";
      this.render();
      return;
    }

    const generation = ++this.scanGeneration;
    this.scanContext = context;
    this.scanResults = null;
    this.scanProgressMsg = '';
    this.inlineQuickResults.clear();
    this.inlineLoading.clear();
    this.isScanning = true;
    this.scanErrorMessage = "";
    this.render();

    try {
      let scanner;
      if (backend === 'groq') {
        scanner = new GroqScannerService(this.plugin.settings.groqApiKey, this.plugin.settings.groqModel, this.plugin);
      } else if (backend === 'openrouter') {
        scanner = new OpenAiCompatibleScannerService(this.plugin.settings.openAiBaseUrl, this.plugin.settings.openAiApiKey, this.plugin.settings.openAiModel);
      } else if (backend === 'offline') {
        scanner = new OfflineMedicalScanner();
      } else {
        scanner = new GeminiScannerService(this.plugin.settings.geminiApiKey, this.plugin.settings.geminiModel, this.plugin);
      }
      const max = this.plugin.settings.geminiMaxSuggestions || 20;
      const results = await scanner.scanNote(title, content, max, (msg) => {
        if (!this.closed && generation === this.scanGeneration) {
          this.scanProgressMsg = msg;
          this.render();
        }
      });
      if (this.closed || generation !== this.scanGeneration) return;
      this.scanResults = results;
      new Notice(
        `Identified ${this.scanResults.suggestions.length} high-yield visual opportunities!`,
        5000
      );
    } catch (err) {
      if (this.closed || generation !== this.scanGeneration) return;
      this.scanErrorMessage = safeError(err);
      new Notice(`Scan failed: ${this.scanErrorMessage}`, 7000);
    } finally {
      if (!this.closed && generation === this.scanGeneration) {
        this.isScanning = false;
        this.render();
      }
    }
  }

  async executeInlineQuickFind(index, query, visualType) {
    if (this.closed || this.inlineLoading.has(index)) return;
    const generation = this.scanGeneration;
    const context = this.scanContext;
    const suggestion = this.scanResults?.suggestions[index];
    this.inlineLoading.add(index);
    this.render();

    try {
      const provider = this.plugin.getActiveProvider();
      const effectiveQuery = this.getEffectiveQuery(
        query,
        visualType || "diagram"
      );
      const rawResults = await (this.plugin.searchWithCache
        ? this.plugin.searchWithCache(provider, effectiveQuery)
        : normalizeResults(await provider.search(effectiveQuery)));
      const items = this.plugin.searchWithCache ? rawResults : normalizeResults(rawResults);
      if (this.closed || generation !== this.scanGeneration) return;
      this.inlineQuickResults.set(index, items.slice(0, 6).map(item => ({
        ...item,
        targetContext: context,
        targetLine: suggestion?.line,
        targetHeading: suggestion?.heading,
        targetConcept: suggestion?.visualConcept,
        targetQuery: suggestion?.recommendedQuery,
        searchOriginSuggestionIndex: index
      })));
    } catch (err) {
      if (!this.closed && generation === this.scanGeneration) new Notice(`Quick find failed: ${safeError(err)}`);
    } finally {
      if (!this.closed && generation === this.scanGeneration) {
        this.inlineLoading.delete(index);
        this.render();
      }
    }
  }

  setQuery(query, autoSearch = true) {
    this.currentTab = "search";
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
    if (this.closed || !query || !query.trim()) return;
    const generation = ++this.searchGeneration;
    const targetContext = this.searchTargetContext;
    const targetLine = this.searchTargetLine;
    const targetHeading = this.searchTargetHeading;
    const originIdx = this.searchOriginSuggestionIndex;
    this.currentQuery = query;
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
      const rawResults = await (this.plugin.searchWithCache
        ? this.plugin.searchWithCache(provider, effectiveQuery)
        : normalizeResults(await provider.search(effectiveQuery)));
      const results = this.plugin.searchWithCache ? rawResults : normalizeResults(rawResults);
      if (this.closed || generation !== this.searchGeneration) return;
      this.results = results.map(item => ({ ...item, targetContext, targetLine, targetHeading, searchOriginSuggestionIndex: originIdx }));
      this.isSearching = false;
      this.statusType = "normal";
      this.statusMessage =
        this.results.length > 0
          ? `Found ${this.results.length} images${filterTag} via ${provider.name}.`
          : `No images found for this query${filterTag}. Try another filter or search term.`;
    } catch (err) {
      if (this.closed || generation !== this.searchGeneration) return;
      this.isSearching = false;
      this.statusType = "error";
      this.statusMessage = `Error: ${safeError(err)}`;
      this.results = [];
    }
    this.render();
  }

  render() {
    if (this.closed) return;
    const input = this.queryInput;
    const focused = !!input && input.ownerDocument?.activeElement === input;
    const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
    const tabChanged = this._lastRenderedTab !== this.currentTab;
    this._lastRenderedTab = this.currentTab;
    const scrollTop = tabChanged
      ? (this.currentTab === 'scan' ? (this.searchOriginSuggestionIndex == null ? this.scannerScrollTop : 0) : this.searchScrollTop)
      : (this.contentEl ? this.contentEl.scrollTop : 0);
    this.renderContent();
    if (this.contentEl) this.contentEl.scrollTop = scrollTop;
    if (focused && this.currentTab === 'search' && this.queryInput) {
      this.queryInput.focus();
      this.queryInput.setSelectionRange(...selection);
    }
  }

  renderContent() {
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
    const activeFile = this.plugin.getTargetView()?.file;
    if (activeFile) {
      header.createDiv({
        text: `Target: ${activeFile.basename}`,
        cls: "mif-target-note"
      });
    }

    // Tab Bar
    const tabBar = header.createDiv({ cls: "mif-tab-bar" });
    const searchTabBtn = tabBar.createEl("button", {
      text: "🔍 Search Images",
      cls: `mif-tab ${this.currentTab === "search" ? "is-active" : ""}`
    });
    searchTabBtn.type = "button";
    searchTabBtn.onclick = () => {
      if (this.currentTab !== "search") {
        this.currentTab = "search";
        this.render();
      }
    };

    const scanTabBtn = tabBar.createEl("button", {
      text: "✨ AI Visual Scanner",
      cls: `mif-tab ${this.currentTab === "scan" ? "is-active" : ""}`
    });
    scanTabBtn.type = "button";
    scanTabBtn.onclick = () => {
      if (this.currentTab !== "scan") {
        this.currentTab = "scan";
        this.render();
      }
    };

    if (this.currentTab === "scan") {
      this.renderScannerView(root);
      return;
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

    this.queryInput.addEventListener("input", () => {
      this.currentQuery = this.queryInput.value;
      this.searchTargetContext = null;
      this.searchTargetLine = null;
      this.searchTargetHeading = null;
      this.searchOriginSuggestionIndex = null;
    });

    this.queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = this.queryInput.value.trim();
        if (val) this.executeSearch(val);
      }
    });

    // 1. Paste Selection / Clipboard Button
    const pasteBtn = queryWrapper.createEl("button", {
      cls: "mif-btn-icon",
      attr: {
        type: "button",
        "aria-label": "Paste selection from note or clipboard",
        title: "Paste selected text from note"
      }
    });
    pasteBtn.innerHTML = "📋";
    pasteBtn.onclick = () => {
      let text = "";
      const activeView =
        this.plugin.getTargetView();
      if (activeView && activeView.editor) {
        text = activeView.editor.getSelection().trim();
      }
      if (!text) {
        text = electron.clipboard.readText().trim();
      }
      if (text) {
        this.queryInput.value = text;
        this.currentQuery = text;
        this.searchTargetContext = null;
        this.searchTargetLine = null;
        this.queryInput.focus();
        new Notice("Pasted text into search bar!");
      } else {
        new Notice(
          "Select text in your note first, or copy text to clipboard."
        );
      }
    };

    // 2. Clear Button
    const clearBtn = queryWrapper.createEl("button", {
      cls: "mif-btn-icon",
      attr: {
        type: "button",
        "aria-label": "Clear search input",
        title: "Clear query"
      }
    });
    clearBtn.innerHTML = "✕";
    clearBtn.onclick = () => {
      this.queryInput.value = "";
      this.currentQuery = "";
      this.searchTargetContext = null;
      this.searchTargetLine = null;
      this.searchTargetHeading = null;
      this.searchOriginSuggestionIndex = null;
      ++this.searchGeneration;
      this.isSearching = false;
      this.results = [];
      this.statusMessage = '';
      this.render();
      this.queryInput.focus();
    };

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
      { id: "brightdata", label: "Bright Data Google Images (5,000 Free/Mo)" },
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

    // Return to Scanner Banner if search originated from a card
    if (this.searchOriginSuggestionIndex != null) {
      const banner = root.createDiv({ cls: "mif-scanner-return-banner" });
      const label = banner.createSpan({ cls: "mif-return-label" });
      label.setText(`🎯 Topic: ${this.searchTargetHeading || 'Card #' + (this.searchOriginSuggestionIndex + 1)}`);
      const backBtn = banner.createEl("button", {
        cls: "mif-link-btn",
        text: "← Back to AI Scanner"
      });
      backBtn.onclick = () => {
        this.currentTab = "scan";
        this.render();
      };
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
      thumbContainer.title = `${item.title}\nClick to preview • Double-click to open website in browser`;
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
        new ImagePreviewModal(this.app, this.plugin, item, this).open();
      };

      thumbContainer.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetUrl = item.sourceUrl || item.imageUrl;
        if (openExternalUrl(targetUrl)) {
          new Notice(`🌐 Opening source in browser: ${item.domain || "Web"}`);
        }
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
      this.plugin.bindAction(copyBtn, item, "copy");
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        copyBtn.disabled = true;
        copyBtn.setText("Copying...");
        try {
          await this.plugin.copyImageToClipboard(item);
        } catch (err) {
          new Notice(`Copy failed: ${safeError(err)}`);
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
      this.plugin.bindAction(insertBtn, item, "insert");
      insertBtn.onclick = async (e) => {
        e.stopPropagation();
        insertBtn.disabled = true;
        insertBtn.setText("Inserting...");
        try {
          await this.plugin.saveAndInsertImage(item);
          if (this.scanContext && this.scanContext.file === item.targetContext?.file) {
            this.scanContext.content = this.scanContext.editor.getValue();
          }
          if (this.searchTargetContext && this.searchTargetContext.file === item.targetContext?.file) {
            this.searchTargetContext.content = this.searchTargetContext.editor.getValue();
          }
          if (item.searchOriginSuggestionIndex != null) {
            this.insertedSuggestionIndices.add(item.searchOriginSuggestionIndex);
            this.lastActiveScannerIndex = item.searchOriginSuggestionIndex;
            this.currentTab = "scan";
            this.render();
          }
        } catch (err) {
          new Notice(`Insert failed: ${safeError(err)}`);
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
        new ImagePreviewModal(this.app, this.plugin, item, this).open();
      };

      if (item.sourceUrl) {
        const sourceLink = subActions.createEl("button", {
          text: "🌐 Source ↗",
          cls: "mif-link-btn"
        });
        sourceLink.onclick = () => {
          if (openExternalUrl(item.sourceUrl)) {
            new Notice(`🌐 Opening source in browser: ${item.domain || "Web"}`);
          }
        };
      }
    });
  }

  renderScannerView(root) {
    const container = root.createDiv({ cls: "mif-scan-container" });

    // Hero box
    const hero = container.createDiv({ cls: "mif-scan-hero" });
    hero.createEl("h4", {
      text: "⚡ AI Note Visual Scanner",
      cls: "mif-scan-hero-title"
    });
    hero.createEl("p", {
      text: "Audits your active surgical note to identify missing anatomical danger zones, triangles, operative repair layers, and radiological signs.",
      cls: "mif-scan-hero-desc"
    });

    // Image Count Selector Row
    const countRow = hero.createDiv({ cls: "mif-scan-count-row" });
    countRow.createSpan({ text: "🎯 Target Images:", cls: "mif-scan-count-label" });
    const countSelect = countRow.createEl("select", { cls: "mif-scan-count-select" });
    const countOptions = [5, 10, 15, 20, 25, 30, 40, 50];
    const currentCount = this.plugin.settings.geminiMaxSuggestions || 25;
    for (const val of countOptions) {
      const opt = countSelect.createEl("option", { text: `${val} images`, value: String(val) });
      if (val === currentCount) opt.selected = true;
    }
    countSelect.onchange = async () => {
      const newCount = parseInt(countSelect.value, 10);
      if (!isNaN(newCount)) {
        this.plugin.settings.geminiMaxSuggestions = newCount;
        await this.plugin.saveSettings();
        new Notice(`Target set to ${newCount} images per note.`);
      }
    };

    const activeFile = this.plugin.getTargetView()?.file;

    // 1-Click Clipboard Bridge primary button
    const copyPromptBtn = hero.createEl("button", {
      cls: "mif-scan-btn",
      text: "📋 Copy Note & Prompt for Alt+G Gemini"
    });
    copyPromptBtn.title = "Copies 100% full note numbered [L1]..[Ln] with MBBS prompt. Then press Alt+G, paste, and enter in Gemini.";
    copyPromptBtn.onclick = () => {
      this.copyNotePromptForAltG();
    };

    // Bridge action row
    const bridgeActionRow = hero.createDiv({ cls: "mif-scan-actions" });
    bridgeActionRow.style.marginTop = "4px";

    const importBtn = bridgeActionRow.createEl("button", {
      cls: "mif-btn mif-btn-insert",
      text: "📥 Import Gemini Response"
    });
    importBtn.title = "Open paste window to import Gemini's JSON or Markdown response";
    importBtn.onclick = () => {
      new GeminiResponseImportModal(this.app, this.plugin, this).open();
    };

    const pasteClipBtn = bridgeActionRow.createEl("button", {
      cls: "mif-btn",
      text: "📋 Paste from Clipboard"
    });
    pasteClipBtn.title = "Quick-import directly from system clipboard";
    pasteClipBtn.onclick = () => {
      this.importGeminiResponseFromClipboard();
    };

    // Optional API scan button
    if (this.plugin.settings.geminiApiKey || this.plugin.settings.groqApiKey || this.plugin.settings.openAiApiKey) {
      const apiBtn = bridgeActionRow.createEl("button", {
        cls: "mif-btn mif-btn-copy",
        text: this.isScanning ? "⏳ Scanning API..." : "⚡ Scan via API"
      });
      apiBtn.disabled = this.isScanning;
      apiBtn.onclick = () => {
        this.executeNoteScan();
      };
    }

    // Step 2 guidance banner if user clicked copy prompt
    if (this.waitingForGemini) {
      const step2Box = container.createDiv({ cls: "mif-scan-hero" });
      step2Box.style.background = "var(--background-primary-alt)";
      step2Box.style.borderLeft = "3px solid var(--interactive-accent)";
      step2Box.createEl("h5", {
        text: `⏳ Waiting for Gemini (${this.copiedPromptNote || "Active Note"})`,
        style: "margin: 0 0 4px 0; font-size: 12px; font-weight: 600;"
      });
      const stepDesc = step2Box.createEl("p", { cls: "mif-scan-hero-desc" });
      stepDesc.innerHTML = "1. Press <kbd>Alt+G</kbd> to summon Gemini.<br>2. Paste (<kbd>Ctrl+V</kbd>) and hit Enter.<br>3. Copy Gemini's response, then click below:";

      const stepActions = step2Box.createDiv({ cls: "mif-scan-actions" });
      stepActions.style.marginTop = "6px";

      const pasteNowBtn = stepActions.createEl("button", {
        cls: "mif-btn mif-btn-insert",
        text: "📥 Paste from Clipboard & Show Cards"
      });
      pasteNowBtn.onclick = () => {
        this.importGeminiResponseFromClipboard();
      };

      const manualPasteBtn = stepActions.createEl("button", {
        cls: "mif-btn",
        text: "📝 Paste Manually"
      });
      manualPasteBtn.onclick = () => {
        new GeminiResponseImportModal(this.app, this.plugin, this).open();
      };

      const cancelWaitBtn = stepActions.createEl("button", {
        cls: "mif-btn",
        text: "Cancel"
      });
      cancelWaitBtn.onclick = () => {
        this.stopClipboardWatcher();
        this.waitingForGemini = false;
        this.render();
      };
    }

    // Error alert
    if (this.scanErrorMessage) {
      const errBox = container.createDiv({ cls: "mif-status is-error" });
      errBox.setText(this.scanErrorMessage);
    }

    // Loading indicator
    if (this.isScanning) {
      const loadingBox = container.createDiv({
        cls: "mif-status is-loading"
      });
      loadingBox.setText(
        this.scanProgressMsg || "🧠 Analyzing with Gemini..."
      );
      return;
    }

    // Empty state before scan / import
    if (!this.scanResults) {
      if (!this.waitingForGemini) {
        const emptyState = container.createDiv({ cls: "mif-empty-state" });
        emptyState.createDiv({ text: "🔬", cls: "mif-empty-icon" });
        emptyState.createEl("h3", { text: "Scan Note for Visual Gaps" });
        emptyState.createEl("p", {
          text: "Open any medical or surgical note in Obsidian, click 'Copy Note & Prompt for Alt+G Gemini' above, paste into Gemini, and import the response!"
        });
      }
      return;
    }

    if (this.scanContext) {
      container.createDiv({ cls: 'mif-target-note', text: `Scanned: ${this.scanContext.file.basename}` });
      try { this.plugin.validateTarget(this.scanContext); }
      catch (_) { container.createDiv({ cls: 'mif-status is-error', text: 'The scanned note changed or closed. Rescan before jumping or inserting.' }); }
    }

    // Results summary
    const summaryBox = container.createDiv({ cls: "mif-status" });
    const summaryHeader = summaryBox.createDiv({ cls: "mif-summary-header" });
    summaryHeader.createEl("strong", { text: "Visual Audit: " });
    summaryHeader.createSpan({
      text: `${this.scanResults.summary} (${this.scanResults.suggestions.length} high-yield visual opportunities)`
    });

    if (this.restoredFromMemory && this.plugin.settings.lastScannedNote) {
      const memTag = summaryBox.createDiv({
        cls: "mif-memory-tag",
        text: `💾 Restored previous scan (${this.plugin.settings.lastScannedNote})`
      });
      memTag.style.fontSize = "11px";
      memTag.style.color = "var(--text-muted)";
      memTag.style.marginTop = "4px";
    }

    const resetRow = summaryBox.createDiv({ cls: "mif-summary-reset-row" });
    resetRow.style.marginTop = "6px";
    const clearMemBtn = resetRow.createEl("button", {
      cls: "mif-btn mif-btn-clear-mem",
      text: "🗑️ Clear Audit / Rescan"
    });
    clearMemBtn.onclick = () => {
      this.clearScanMemory();
    };

    // Batch Actions Row
    const batchBar = container.createDiv({ cls: "mif-batch-bar" });
    const batchModalBtn = batchBar.createEl("button", {
      cls: "mif-btn mif-btn-insert mif-batch-btn",
      text: "⚡ Fast Batch Image Review"
    });
    batchModalBtn.title = "Review top 3 image choices per suggestion in a fast grid and insert all selected with 1 click!";
    batchModalBtn.onclick = () => {
      new BatchImageReviewModal(this.app, this.plugin, this).open();
    };

    const autoPilotBtn = batchBar.createEl("button", {
      cls: "mif-btn mif-batch-autopilot-btn",
      text: "🚀 1-Click Auto-Pilot"
    });
    autoPilotBtn.title = "Automatically fetches and inserts #1 best image for all suggestions from bottom to top with zero drift!";
    autoPilotBtn.onclick = () => {
      this.runAutoPilotBatch();
    };

    // Suggestions list
    this.scanResults.suggestions.forEach((s, idx) => {
      const card = container.createDiv({
        cls: `mif-scan-card ${this.insertedSuggestionIndices.has(idx) ? 'is-inserted' : ''}`
      });
      card.id = `mif-card-${idx}`;
      if (typeof card.setAttribute === "function") card.setAttribute("data-idx", String(idx));

      // Header row
      const headerRow = card.createDiv({ cls: "mif-scan-header-row" });
      if (this.insertedSuggestionIndices.has(idx)) {
        headerRow.createSpan({
          text: "✓ Inserted",
          cls: "mif-badge mif-badge-inserted"
        });
      }
      const headingEl = headerRow.createSpan({
        text: `📍 ${s.heading}`,
        cls: "mif-scan-heading"
      });
      headingEl.title = `Line ${s.line}`;
      headingEl.style.cursor = "pointer";
      headingEl.onclick = () => this.jumpToLine(s.line);

      // Category badge
      const filterObj = MEDICAL_VISUAL_FILTERS.find(
        (f) => f.id === (s.visualType || "diagram")
      );
      headerRow.createSpan({
        text: filterObj ? filterObj.label : "Diagram",
        cls: "mif-badge"
      });

      // Concept Title
      card.createEl("h4", {
        text: s.visualConcept,
        cls: "mif-scan-concept"
      });

      // Exam Rationale
      if (s.rationale) {
        card.createDiv({
          text: s.rationale,
          cls: "mif-scan-rationale"
        });
      }

      // Query display
      if (s.recommendedQuery) {
        const queryRow = card.createDiv({ cls: "mif-scan-hero-desc" });
        queryRow.style.fontSize = "11px";
        queryRow.style.color = "var(--text-muted)";
        queryRow.createSpan({ text: "🔍 Query: ", style: "font-weight: 600;" });
        queryRow.createSpan({ text: s.recommendedQuery });
      }

      // Actions
      const actions = card.createDiv({ cls: "mif-scan-actions" });

      const quickFindBtn = actions.createEl("button", {
        text: this.inlineLoading.has(idx) ? "Searching..." : "⚡ Quick find",
        cls: "mif-btn mif-btn-insert"
      });
      quickFindBtn.disabled = this.inlineLoading.has(idx);
      quickFindBtn.title = "Search DuckDuckGo and display multiple image options under this card";
      quickFindBtn.onclick = () => {
        this.executeInlineQuickFind(idx, s.recommendedQuery, s.visualType);
      };

      const searchThisBtn = actions.createEl("button", {
        text: "🔍 Search images",
        cls: "mif-btn mif-btn-copy"
      });
      searchThisBtn.title = "Explore 20+ DuckDuckGo image options in main search tab";
      searchThisBtn.onclick = () => {
        this.searchTargetContext = this.scanContext;
        this.searchTargetLine = s.line;
        this.searchTargetHeading = s.heading;
        this.searchOriginSuggestionIndex = idx;
        this.lastActiveScannerIndex = idx;
        this.switchToSearchTab(
          s.recommendedQuery,
          s.visualType || "diagram",
          true
        );
      };

      const jumpBtn = actions.createEl("button", {
        text: `📍 Line ${s.line}`,
        cls: "mif-btn"
      });
      jumpBtn.title = `Jump cursor to line ${s.line} in active note`;
      jumpBtn.onclick = () => this.jumpToLine(s.line);

      // Inline Quick Results (multiple DuckDuckGo options)
      if (this.inlineQuickResults.has(idx)) {
        const inlineList = this.inlineQuickResults.get(idx);
        if (inlineList.length > 0) {
          const inlineContainer = card.createDiv({
            cls: "mif-inline-results"
          });
          inlineList.forEach((item) => {
            const tile = inlineContainer.createDiv({
              cls: "mif-inline-thumb-card"
            });
            tile.title = `${item.title}\nClick to preview • Double-click to open website in browser`;
            tile.createEl("img", {
              cls: "mif-inline-thumb-img",
              attr: {
                src: item.thumbnailUrl || item.imageUrl,
                alt: item.title,
                loading: "lazy"
              }
            });
            tile.onclick = () => {
              new ImagePreviewModal(this.app, this.plugin, item, this).open();
            };
            tile.ondblclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              const targetUrl = item.sourceUrl || item.imageUrl;
              if (openExternalUrl(targetUrl)) {
                new Notice(`🌐 Opening source in browser: ${item.domain || "Web"}`);
              }
            };

            const tileActions = tile.createDiv({
              cls: "mif-inline-thumb-actions"
            });
            const cBtn = tileActions.createEl("button", {
              text: "📋 Copy",
              cls: "mif-link-btn"
            });
            this.plugin.bindAction(cBtn, item, "copy");
            cBtn.onclick = async (e) => {
              cBtn.disabled = true;
              e.stopPropagation();
              try {
                await this.plugin.copyImageToClipboard(item);
              } catch (err) {
                new Notice(`Copy failed: ${safeError(err)}`);
              } finally {
                cBtn.disabled = false;
              }
            };

            const iBtn = tileActions.createEl("button", {
              text: "📥 Insert",
              cls: "mif-link-btn"
            });
            this.plugin.bindAction(iBtn, item, "insert");
            iBtn.onclick = async (e) => {
              iBtn.disabled = true;
              e.stopPropagation();
              try {
                await this.plugin.saveAndInsertImage(item);
                if (this.scanContext && this.scanContext.file === item.targetContext?.file) {
                  this.scanContext.content = this.scanContext.editor.getValue();
                }
                if (this.searchTargetContext && this.searchTargetContext.file === item.targetContext?.file) {
                  this.searchTargetContext.content = this.searchTargetContext.editor.getValue();
                }
                this.insertedSuggestionIndices.add(idx);
                this.lastActiveScannerIndex = idx;
                this.render();
              } catch (err) {
                new Notice(`Insert failed: ${safeError(err)}`);
              } finally {
                iBtn.disabled = false;
              }
            };
          });
        } else {
          const noRes = card.createDiv({ cls: "mif-status" });
          noRes.setText("No images found on DuckDuckGo for this query. Try 'Search images' with modified keywords.");
        }
      }
    });

    // Auto-scroll to where user clicked 'Search images' or last acted
    const scrollTargetIdx = this.searchOriginSuggestionIndex != null ? this.searchOriginSuggestionIndex : this.lastActiveScannerIndex;
    if (scrollTargetIdx != null) {
      const setTimeoutFn = (typeof window !== "undefined" && window.setTimeout) || setTimeout;
      setTimeoutFn(() => {
        const rootContainer = this.contentEl || this.containerEl || (typeof document !== "undefined" ? document : null);
        const cardEl = rootContainer ? rootContainer.querySelector(`#mif-card-${scrollTargetIdx}`) : null;
        if (cardEl && typeof cardEl.scrollIntoView === "function") {
          cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
          if (typeof cardEl.addClass === "function") {
            cardEl.addClass("mif-highlight-pulse");
            setTimeoutFn(() => {
              if (typeof cardEl.removeClass === "function") cardEl.removeClass("mif-highlight-pulse");
            }, 2000);
          }
        }
      }, 50);
    }
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
          .addOption("brightdata", "Bright Data Google Images (5,000 Free/Mo)")
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
            try {
              this.plugin.settings.attachmentFolder = attachmentPath(val);
              await this.plugin.saveSettings();
            } catch (err) { new Notice(safeError(err)); }
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

    containerEl.createEl("h3", { text: "Bright Data Google Images (5,000 Free Records/Month)" });
    containerEl.createEl("p", {
      text: "5,000 free Google Image records every month (no credit card required). Sign up at brightdata.com, copy your API token from Account Settings → API Keys, and enter it below.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Bright Data API Key")
      .setDesc("Enter your Bright Data API token (Bearer token).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Bearer token or API key")
          .setValue(this.plugin.settings.brightDataApiKey)
          .onChange(async (val) => {
            this.plugin.settings.brightDataApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Bright Data SERP Zone")
      .setDesc("Zone name configured in your Bright Data dashboard (defaults to 'serp_api1').")
      .addText((text) => {
        text
          .setPlaceholder("serp_api1")
          .setValue(this.plugin.settings.brightDataZone || "serp_api1")
          .onChange(async (val) => {
            this.plugin.settings.brightDataZone = val.trim() || "serp_api1";
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Gemini AI Note Scanner (Free)" });
    containerEl.createEl("p", {
      text: "Scans surgical and medical notes to identify visual gaps (anatomical triangles, repairs, signs) and recommend high-yield images. Get a free API key at https://aistudio.google.com/app/apikey.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("Enter your Google Gemini API key.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("AIzaSy...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (val) => {
            this.plugin.settings.geminiApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    const modelSetting = new Setting(containerEl)
      .setName("Gemini Model")
      .setDesc("Model used for medical curriculum analysis.")
      .addDropdown((drop) => {
        const customModels = this.plugin.settings.geminiCustomModels;
        if (customModels && customModels.length > 0) {
          customModels.forEach(m => drop.addOption(m.id, m.label));
        } else {
          drop
            .addOption("gemini-2.5-flash", "gemini-2.5-flash (Fast, Recommended)")
            .addOption("gemini-2.0-flash", "gemini-2.0-flash")
            .addOption("gemini-1.5-flash", "gemini-1.5-flash")
            .addOption("gemini-1.5-pro", "gemini-1.5-pro (Deeper Analysis)");
        }
        drop
          .setValue(this.plugin.settings.geminiModel || "gemini-2.5-flash")
          .onChange(async (val) => {
            this.plugin.settings.geminiModel = val;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Fetch models")
          .setTooltip("Load available models from your Gemini API key")
          .onClick(async () => {
            const apiKey = this.plugin.settings.geminiApiKey;
            if (!apiKey) {
              new Notice("⚠️ Enter your Gemini API key first.");
              return;
            }
            btn.setButtonText("Fetching…");
            btn.setDisabled(true);
            try {
              const res = await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
                headers: { "Content-Type": "application/json" }
              });
              const data = res.json;
              if (!data || !Array.isArray(data.models)) throw new Error("Unexpected API response.");
              const fetched = data.models
                .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
                .map(m => ({ id: m.name.replace("models/", ""), label: m.displayName || m.name.replace("models/", "") }));
              if (fetched.length === 0) throw new Error("No generateContent-capable models found.");
              this.plugin.settings.geminiCustomModels = fetched;
              if (!fetched.find(m => m.id === this.plugin.settings.geminiModel)) {
                this.plugin.settings.geminiModel = fetched[0].id;
              }
              await this.plugin.saveSettings();
              new Notice(`✅ Loaded ${fetched.length} Gemini models.`);
              this.display();
            } catch (err) {
              new Notice(`❌ Failed to fetch models: ${safeError(err)}`);
              btn.setButtonText("Fetch models");
              btn.setDisabled(false);
            }
          });
      });

    containerEl.createEl("h3", { text: "AI & Local Note Visual Scanner" });
    containerEl.createEl("p", {
      text: "Scans your entire clinical/surgical note to identify missing diagrams, pathognomonic signs, classifications, and HPE patterns for MBBS exam prep.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Visual Scanner Backend")
      .setDesc("Choose which AI scans your note. Gemini scans 100% of your full unabridged note (1M tokens). OpenRouter/Cerebras supports free LLMs from awesome-free-llm-apis.")
      .addDropdown(drop => {
        drop
          .addOption("gemini",     "Google Gemini — Scans 100% Full Note (Recommended)")
          .addOption("openrouter", "OpenRouter / Cerebras (Free LLMs from awesome-free-llm-apis)")
          .addOption("groq",       "Groq LPU (Ultra-fast, Llama 3.1 8B)")
          .addOption("offline",    "Local Medical Rules Engine (Offline)")
          .setValue(this.plugin.settings.aiBackend || "gemini")
          .onChange(async val => {
            this.plugin.settings.aiBackend = val;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Groq API Key")
      .setDesc("Free at console.groq.com/keys — 14,400 req/day, no credit card needed.")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("gsk_...")
          .setValue(this.plugin.settings.groqApiKey || "")
          .onChange(async val => {
            this.plugin.settings.groqApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Groq Model")
      .setDesc("Model ID to use. The plugin auto-falls back through known models if yours is decommissioned. Click 'Fetch Models' to get the live list from Groq.")
      .addText(text => {
        text
          .setPlaceholder("e.g. llama-3.3-70b-versatile")
          .setValue(this.plugin.settings.groqModel || "llama-3.3-70b-versatile")
          .onChange(async val => {
            this.plugin.settings.groqModel = val.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "260px";
      })
      .addButton(btn => {
        btn.setButtonText("Fetch Live Models").onClick(async () => {
          const key = this.plugin.settings.groqApiKey;
          if (!key) { new Notice("Enter your Groq API key first."); return; }
          btn.setButtonText("Fetching...").setDisabled(true);
          try {
            const r = await requestUrl({
              url: "https://api.groq.com/openai/v1/models",
              method: "GET",
              headers: { Authorization: "Bearer " + key }
            });
            const models = (r.json.data || [])
              .filter(m => m.object === "model" && !m.id.includes("whisper") && !m.id.includes("guard") && !m.id.includes("safeguard"))
              .map(m => m.id)
              .sort();
            if (models.length === 0) { new Notice("No text models found."); return; }
            // Show modal with clickable list
            const modal = new Modal(this.app);
            modal.titleEl.setText("Live Groq Models ("+models.length+")");
            models.forEach(id => {
              const row = modal.contentEl.createEl("div", { cls: "setting-item" });
              row.createEl("span", { text: id, cls: "setting-item-name" });
              const useBtn = row.createEl("button", { text: "Use", cls: "mod-cta" });
              useBtn.style.marginLeft = "12px";
              useBtn.onclick = async () => {
                this.plugin.settings.groqModel = id;
                await this.plugin.saveSettings();
                modal.close();
                this.display();
                new Notice("Groq model set to: " + id);
              };
            });
            modal.open();
          } catch(e) {
            new Notice("Failed to fetch models: " + (e.message || e));
          } finally {
            btn.setButtonText("Fetch Live Models").setDisabled(false);
          }
        });
      });

    // --- OpenRouter & Free LLM APIs (awesome-free-llm-apis) ---
    containerEl.createEl("h3", { text: "OpenRouter & Free LLM APIs (awesome-free-llm-apis)" });
    containerEl.createEl("p", {
      text: "Use free models like Llama 3.3 70B, DeepSeek R1, or Cerebras from the mnfst/awesome-free-llm-apis catalog. Get a free key at openrouter.ai/keys (no credit card).",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Provider Base URL")
      .setDesc("Base URL for the OpenAI-compatible endpoint. OpenRouter: https://openrouter.ai/api/v1 | Cerebras: https://api.cerebras.ai/v1")
      .addText(text => {
        text
          .setPlaceholder("https://openrouter.ai/api/v1")
          .setValue(this.plugin.settings.openAiBaseUrl || "https://openrouter.ai/api/v1")
          .onChange(async val => {
            this.plugin.settings.openAiBaseUrl = val.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "300px";
      });

    new Setting(containerEl)
      .setName("Provider API Key")
      .setDesc("API key for OpenRouter, Cerebras, or other free providers.")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-or-v1-...")
          .setValue(this.plugin.settings.openAiApiKey || "")
          .onChange(async val => {
            this.plugin.settings.openAiApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model Identifier")
      .setDesc("Exact model ID to use (e.g. meta-llama/llama-3.3-70b-instruct:free or deepseek/deepseek-r1:free).")
      .addText(text => {
        text
          .setPlaceholder("meta-llama/llama-3.3-70b-instruct:free")
          .setValue(this.plugin.settings.openAiModel || "meta-llama/llama-3.3-70b-instruct:free")
          .onChange(async val => {
            this.plugin.settings.openAiModel = val.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "320px";
      });

    new Setting(containerEl)
      .setName("Max Visual Suggestions Per Scan")
      .setDesc("How many image suggestions are generated per scan (capped at 25 high-yield suggestions).")
      .addDropdown((drop) => {
        drop
          .addOption("5",  "5  — Quick overview")
          .addOption("10", "10 — Focused")
          .addOption("15", "15 — Standard")
          .addOption("20", "20 — Detailed")
          .addOption("25", "25 — Recommended (MBBS High-Yield)")
          .addOption("30", "30 — Extensive")
          .addOption("40", "40 — Deep Chapter Audit")
          .addOption("50", "50 — Maximum Exhaustive")
          .setValue(String(this.plugin.settings.geminiMaxSuggestions || 25))
          .onChange(async (val) => {
            this.plugin.settings.geminiMaxSuggestions = parseInt(val, 10);
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
    this.disposed = false;
    this.pendingActions = new Map();
    this.writeQueue = Promise.resolve();
    this.searchCache = new SearchCache();
    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (!(leaf?.view instanceof MarkdownView)) return;
      this.lastMarkdownView = leaf.view;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIF)) leaf.view.render();
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.getTargetView();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIF)) leaf.view.render();
    }));
    this.registerEvent(this.app.workspace.on('editor-change', () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIF)) {
        if (leaf.view.currentTab === 'scan') leaf.view.render();
      }
    }));

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

    // Command: Scan note for visual opportunities (AI)
    this.addCommand({
      id: "scan-note-visuals",
      name: "Scan note for visual opportunities (AI)",
      callback: () => {
        this.triggerScanFromCommand();
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
    this.disposed = true;
    if (this.searchCache) this.searchCache.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MIF);
  }

  async searchWithCache(provider, query, bypassCache = false) {
    if (!query || !query.trim()) return [];
    const pId = provider.name || provider.constructor.name || "default";
    const cacheKey = `${pId}:${query.trim().toLowerCase()}`;
    if (!bypassCache && this.searchCache) {
      const cached = this.searchCache.get(cacheKey);
      if (cached) return cached;
    }
    const results = await provider.search(query);
    const normalized = normalizeResults(results);
    if (!bypassCache && this.searchCache && normalized.length > 0) {
      this.searchCache.set(cacheKey, normalized);
    }
    return normalized;
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
    rememberSecrets(this.settings);
  }

  async saveSettings() {
    rememberSecrets(this.settings);
    if (this.searchCache) this.searchCache.clear();
    const snapshot = JSON.parse(JSON.stringify(this.settings));
    const pending = (this.settingsWriteQueue || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    this.settingsWriteQueue = pending;
    try { await pending; }
    catch (err) { new Notice(`Settings could not be saved: ${safeError(err)}`); }
  }

  getProvider(providerId = null) {
    const id = providerId || this.settings.defaultProvider || "duckduckgo";
    switch (id) {
      case "brightdata":
        return new BrightDataProvider(this.settings.brightDataApiKey, this.settings.brightDataZone);
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

  getActiveProvider() {
    return this.getProvider(this.settings.defaultProvider);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MIF)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) throw new Error("No sidebar is available.");
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
    this.lastMarkdownView = view;
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
      leafView.searchTargetContext = null;
      leafView.searchTargetLine = null;
      leafView.setQuery(query, true);
    }
  }

  async triggerScanFromCommand() {
    const leafView = await this.activateView();
    if (leafView && typeof leafView.switchToScanTab === "function") {
      leafView.switchToScanTab(true);
    }
  }


  getTargetView() {
    // 1. Try the actively-focused markdown view
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) { this.lastMarkdownView = active; return active; }
    // 2. Sidebar has focus — check lastMarkdownView is still open
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (this.lastMarkdownView?.file && leaves.some(l => l.view === this.lastMarkdownView)) {
      return this.lastMarkdownView;
    }
    // 3. Fall back to any open markdown leaf (last = most recently active)
    for (let i = leaves.length - 1; i >= 0; i--) {
      const v = leaves[i].view;
      if (v?.file) { this.lastMarkdownView = v; return v; }
    }
    return null;
  }

  static extractConceptKeywords(concept, query) {
    const STOPWORDS = new Set([
      'labeled', 'diagram', 'diagrams', 'schematic', 'illustration', 'radiology',
      'radiograph', 'x-ray', 'xray', 'ct', 'mri', 'usg', 'ultrasound', 'hpe',
      'histology', 'clinical', 'surgical', 'criteria', 'scoring', 'sign', 'signs',
      'view', 'cross-section', 'normal', 'abnormal', 'image', 'picture', 'pathology',
      'features', 'pattern', 'overview', 'comparison', 'vs', 'and', 'the', 'of',
      'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'an', 'a', 'or', 'as', 'is', 'are',
      'if', 'it', 'be', 'so', 'no', 'do', 'my', 'up', 'we', 'he', 'me', 'us'
    ]);
    const text = `${concept || ""} ${query || ""}`.toLowerCase();
    const words = text.match(/[a-z0-9'-]{2,}/g) || [];
    const cleaned = [];
    const seen = new Set();
    for (const w of words) {
      const clean = w.replace(/^['-]+|['-]+$/g, "");
      if (clean.length >= 2 && !STOPWORDS.has(clean) && !seen.has(clean)) {
        seen.add(clean);
        cleaned.push(clean);
      }
    }
    return cleaned;
  }

  findTopicInsertionPosition(editor, line = null, heading = null, concept = null, query = null) {
    const lineCount = editor.lineCount();
    if (lineCount === 0) return { line: 0, ch: 0 };

    let startLineIdx;
    if (line != null && line > 0) {
      startLineIdx = Math.max(0, Math.min(line - 1, lineCount - 1));
    } else {
      startLineIdx = editor.getCursor('to').line;
    }

    let headingIdx = null;
    let headingLevel = 0;

    const startLineText = editor.getLine(startLineIdx);
    const headingMatch = startLineText.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      headingIdx = startLineIdx;
      headingLevel = headingMatch[1].length;
    } else {
      if (heading && typeof heading === "string") {
        const cleanTarget = heading.replace(/^[0-9]+[.)]\s*/, "").trim().toLowerCase();
        for (let offset = -15; offset <= 15; offset++) {
          const cand = startLineIdx + offset;
          if (cand >= 0 && cand < lineCount) {
            const candText = editor.getLine(cand);
            const m = candText.match(/^(#{1,6})\s+(.*)/);
            if (m) {
              const candClean = m[2].replace(/^[0-9]+[.)]\s*/, "").trim().toLowerCase();
              if (cleanTarget && (candClean.includes(cleanTarget) || cleanTarget.includes(candClean))) {
                headingIdx = cand;
                headingLevel = m[1].length;
                break;
              }
            }
          }
        }
      }

      if (headingIdx === null) {
        for (let up = startLineIdx; up >= 0; up--) {
          const upText = editor.getLine(up);
          const m = upText.match(/^(#{1,6})\s+(.*)/);
          if (m) {
            headingIdx = up;
            headingLevel = m[1].length;
            break;
          }
        }
      }
    }

    if (headingIdx !== null) {
      const sectionStartIdx = headingIdx + 1;
      let sectionEndIdx = lineCount;

      for (let curr = sectionStartIdx; curr < lineCount; curr++) {
        const lineText = editor.getLine(curr);
        const trimmed = lineText.trim();
        const nextHeading = lineText.match(/^(#{1,6})\s+/);
        if (nextHeading && nextHeading[1].length <= headingLevel) {
          sectionEndIdx = curr;
          break;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          sectionEndIdx = curr;
          break;
        }
      }

      // Keyword matching within the section to find specific point/bullet
      const kw = MedicalImageFinderPlugin.extractConceptKeywords(concept, query);
      let bestMatchIdx = null;
      let bestMatchScore = 0;

      if (kw.length > 0) {
        for (let cIdx = sectionStartIdx; cIdx < sectionEndIdx; cIdx++) {
          const cLower = editor.getLine(cIdx).toLowerCase();
          let score = 0;
          for (const w of kw) {
            const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(cLower)) {
              score += 3;
            } else if (w.length >= 4 && cLower.includes(w)) {
              score += 1;
            }
          }
          if (score > 0 && line != null) {
            const dist = Math.abs(cIdx - (line - 1));
            if (dist === 0) score += 4;
            else if (dist <= 2) score += 2;
            else if (dist <= 5) score += 1;
          }
          if (score > bestMatchScore || (score === bestMatchScore && bestMatchIdx !== null && line != null && Math.abs(cIdx - (line - 1)) < Math.abs(bestMatchIdx - (line - 1)))) {
            bestMatchScore = score;
            bestMatchIdx = cIdx;
          }
        }
      }

      let targetPointIdx = null;
      if (bestMatchIdx !== null && bestMatchScore >= 2) {
        targetPointIdx = bestMatchIdx;
      } else if (line != null && (line - 1) >= sectionStartIdx && (line - 1) < sectionEndIdx) {
        targetPointIdx = line - 1;
      }

      if (targetPointIdx !== null) {
        // Expand to end of bullet block (including child sub-bullets)
        const pText = editor.getLine(targetPointIdx);
        const bulletMatch = pText.match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (bulletMatch) {
          const parentIndent = bulletMatch[1].length;
          let currEnd = targetPointIdx;
          for (let scan = targetPointIdx + 1; scan < sectionEndIdx; scan++) {
            const sLine = editor.getLine(scan);
            const sTrim = sLine.trim();
            if (!sTrim) {
              // Look ahead to check if next non-empty line is still a child bullet
              let nextChild = false;
              for (let la = scan + 1; la < sectionEndIdx; la++) {
                const laLine = editor.getLine(la);
                if (laLine.trim()) {
                  const laBm = laLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
                  if (laBm && laBm[1].length > parentIndent) nextChild = true;
                  break;
                }
              }
              if (nextChild) continue;
              break;
            }
            const sBm = sLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
            if (sBm) {
              const childIndent = sBm[1].length;
              if (childIndent > parentIndent) {
                currEnd = scan;
                continue;
              } else {
                break; // Hit a sibling or parent bullet
              }
            } else {
              // Continuation line of the bullet
              currEnd = scan;
            }
          }
          return {
            line: currEnd,
            ch: editor.getLine(currEnd).length
          };
        }

        // Paragraph: scan to end of paragraph
        let currEnd = targetPointIdx;
        for (let scan = targetPointIdx + 1; scan < sectionEndIdx; scan++) {
          const sTrim = editor.getLine(scan).trim();
          if (!sTrim || /^[-*+]\s+/.test(sTrim) || sTrim.startsWith('#') || /^\d+[.)]\s+/.test(sTrim)) {
            break;
          }
          currEnd = scan;
        }
        return {
          line: currEnd,
          ch: editor.getLine(currEnd).length
        };
      }

      // Fallback: place below last content of the section
      let lastContentIdx = headingIdx;
      for (let curr = sectionStartIdx; curr < sectionEndIdx; curr++) {
        if (editor.getLine(curr).trim().length > 0) {
          lastContentIdx = curr;
        }
      }
      return {
        line: lastContentIdx,
        ch: editor.getLine(lastContentIdx).length
      };
    }

    if (line != null) {
      const rawTarget = Math.max(0, Math.min(line - 1, lineCount - 1));
      return {
        line: rawTarget,
        ch: editor.getLine(rawTarget).length
      };
    }

    const cursor = editor.getCursor('to');
    return {
      line: cursor.line,
      ch: cursor.ch
    };
  }

  captureTarget(context = null, line = null, heading = null, concept = null, query = null) {
    const view = context?.view || this.getTargetView();
    if (!view?.file || !view.editor || view.file.extension !== 'md') throw new Error('Open a Markdown note in the editor first.');
    if (context) this.validateTarget(context);
    const editor = view.editor;
    const position = this.findTopicInsertionPosition(editor, line, heading, concept, query);
    return {
      view,
      editor,
      file: view.file,
      path: view.file.path,
      content: editor.getValue(),
      position
    };
  }

  validateTarget(target) {
    if (this.disposed) throw new Error('Plugin was disabled. Retry after enabling it.');
    if (!target || !this.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view === target.view) ||
        target.view.file !== target.file || target.view.file.path !== target.path ||
        this.app.vault.getAbstractFileByPath(target.path) !== target.file ||
        target.view.editor !== target.editor ||
        (target.content !== undefined && target.editor.getValue() !== target.content)) {
      throw new Error('The target note was changed or closed.');
    }
  }

  bindAction(button, item, kind) {
    const key = this.actionKey(item, kind);
    button.disabled = this.pendingActions?.has(key) || false;
    // Existing per-button labels are preserved; disabled state is also restored after a rerender.
  }

  actionKey(item, kind) { return `${kind}:${item.imageUrl || item.thumbnailUrl}`; }

  async runAction(item, kind, action) {
    const key = this.actionKey(item, kind);
    if (this.pendingActions.has(key)) return this.pendingActions.get(key);
    const pending = Promise.resolve().then(action);
    this.pendingActions.set(key, pending);
    try { return await pending; }
    finally {
      this.pendingActions.delete(key);
      if (!this.disposed) for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIF)) leaf.view.render();
    }
  }

  async downloadImage(item) {
    let lastError = new Error('No valid image URL.');
    const candidates = [];
    for (const u of [item?.imageUrl, item?.thumbnailUrl]) {
      if (typeof u === 'string') {
        const h = httpUrl(u);
        if (h && !candidates.includes(h)) candidates.push(h);
        else if (u.startsWith('data:image/') && !candidates.includes(u)) candidates.push(u);
      }
    }
    for (const url of candidates) {
      try {
        let bytes;
        if (url.startsWith('data:image/')) {
          const commaIdx = url.indexOf(',');
          if (commaIdx === -1) throw new Error('Invalid data URI.');
          bytes = Buffer.from(url.slice(commaIdx + 1), 'base64');
        } else {
          const buffer = await fetchBinary(url);
          bytes = Buffer.from(new Uint8Array(buffer));
        }
        const prefix = bytes.subarray(0, 512).toString('utf8').trimStart();
        if (!bytes.length || /^(?:<!doctype\s+html|<html|<head|<body)/i.test(prefix)) throw new Error('The server returned a page instead of an image.');
        let nativeImage = electron.nativeImage.createFromBuffer(bytes);
        if (nativeImage.isEmpty()) nativeImage = await this.decodeViaCanvas(bytes);
        if (nativeImage.isEmpty()) throw new Error('Image decoding failed.');
        const ext = imageExtension(bytes);
        return { bytes: ext ? bytes : nativeImage.toPNG(), ext: ext || 'png', nativeImage };
      } catch (err) { lastError = err; }
    }
    throw new Error(`Unable to load image: ${safeError(lastError)}`);
  }

  async copyImageToClipboard(item) {
    return this.runAction(item, 'copy', async () => {
      const image = await this.downloadImage(item);
      if (this.disposed) throw new Error('Plugin was disabled.');
      electron.clipboard.writeImage(image.nativeImage);
      new Notice('Image copied to clipboard! Press Ctrl+V to paste.', 5000);
    });
  }

  async decodeViaCanvas(nodeBuf) {
    return new Promise((resolve, reject) => {
      const blobUrl = URL.createObjectURL(new Blob([nodeBuf]));
      const img = new Image();
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        URL.revokeObjectURL(blobUrl);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Image decoding timed out.')), 15000);
      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx || !canvas.width || !canvas.height) throw new Error('Image has no drawable pixels.');
          ctx.drawImage(img, 0, 0);
          const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('PNG conversion failed.')), 'image/png'));
          const result = electron.nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
          if (result.isEmpty()) throw new Error('Converted image is empty.');
          finish(null, result);
        } catch (err) { finish(err); }
      };
      img.onerror = () => finish(new Error('Image decoding failed.'));
      img.src = blobUrl;
    });
  }

  generateImageMarkdown(editor, pos, fullPath, width, includeCaption = false, item = null) {
    const lineIndex = Math.max(0, Math.min(pos ? pos.line : 0, (editor ? editor.lineCount() : 1) - 1));
    const targetLine = editor ? (editor.getLine(lineIndex) || '') : '';
    
    // Check if target line is a list bullet (e.g. "- ", "* ", "+ ", "1. ")
    const bulletMatch = targetLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (bulletMatch) {
      // Indent image to align under the text of the bullet (indentation + bullet prefix length)
      // Never insert description/caption text in bullet continuations to maintain pure list continuity
      const indent = ' '.repeat(bulletMatch[0].length);
      return `\n${indent}![[${fullPath}|${width}]]`;
    }

    // Check if target line is an indented continuation line (e.g. existing indented embed or sub-text)
    const indentMatch = targetLine.match(/^(\s+)/);
    if (indentMatch && indentMatch[1].length > 0) {
      const indent = indentMatch[1].replace(/\t/g, '    ');
      return `\n${indent}![[${fullPath}|${width}]]`;
    }

    // If target line is an empty line or at column 0 (e.g. under a heading or standard paragraph)
    let md = targetLine.trim() === '' ? `![[${fullPath}|${width}]]\n` : `\n\n![[${fullPath}|${width}]]\n`;
    if (includeCaption && item) {
      const url = httpUrl(item.sourceUrl).replace(/>/g, '%3E').replace(/</g, '%3C');
      const source = url ? `[${markdownText(item.domain || 'Source')}](<${url}>)` : markdownText(item.domain);
      md += `*${markdownText(cleanText(item.title) || 'Medical reference')}*${source ? ` — ${source}` : ''}\n`;
    }
    return md;
  }

  async saveAndInsertImage(item) {
    const target = this.captureTarget(
      item.targetContext,
      item.targetLine,
      item.targetHeading,
      item.targetConcept || item.visualConcept,
      item.targetQuery || item.recommendedQuery
    );
    if (item.targetLine != null) target.position.ch = target.editor.getLine(target.position.line).length;
    const folderPath = attachmentPath(this.settings.attachmentFolder);
    const width = this.settings.defaultImageWidth;
    const includeCaption = this.settings.includeCaption;
    return this.runAction(item, 'insert', async () => {
      const image = await this.downloadImage(item);
      const save = async () => {
        this.validateTarget(target);
        const hash = crypto.createHash('sha256').update(image.bytes).digest('hex').slice(0, 16);
        const fileName = `${safeFileName(item.title)}-${hash}.${image.ext}`;
        await this.ensureFolder(folderPath);
        this.validateTarget(target);
        const fullPath = `${folderPath}/${fileName}`;
        const existing = this.app.vault.getAbstractFileByPath(fullPath);
        if (existing && !(existing instanceof TFile)) throw new Error('An attachment folder conflicts with the image filename.');
        if (!existing) {
          const binary = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength);
          try { await this.app.vault.createBinary(fullPath, binary); }
          catch (err) {
            const concurrent = this.app.vault.getAbstractFileByPath(fullPath);
            if (!(concurrent instanceof TFile)) throw err;
            const stored = Buffer.from(await this.app.vault.readBinary(concurrent));
            if (!stored.equals(image.bytes)) throw new Error('Attachment conflict; existing file was preserved.');
          }
        } else {
          const stored = Buffer.from(await this.app.vault.readBinary(existing));
          if (!stored.equals(image.bytes)) throw new Error('Attachment conflict; existing file was preserved.');
        }
        this.validateTarget(target);
        const markdown = this.generateImageMarkdown(target.editor, target.position, fullPath, width, includeCaption, item);
        target.editor.replaceRange(markdown, target.position);
        new Notice(`Saved ${fileName} and inserted into ${target.file.basename}.`, 5000);
      };
      const pending = this.writeQueue.then(save);
      this.writeQueue = pending.catch(() => {});
      return pending;
    });
  }

  async batchInsertImages(jobs, onProgress = null) {
    if (!Array.isArray(jobs) || jobs.length === 0) return { insertedCount: 0, successfulIndices: new Set(), failedIndices: new Set() };
    const runBatch = async () => {
      const firstContext = jobs[0].imageItem?.targetContext;
      const target = this.captureTarget(firstContext);
      this.validateTarget(target);
      const editor = target.editor;

      const folderPath = attachmentPath(this.settings.attachmentFolder);
      const width = this.settings.defaultImageWidth;
      const includeCaption = this.settings.includeCaption;
      await this.ensureFolder(folderPath);

      // 1. Calculate insertion positions on original document before any edits
      const plannedJobs = [];
      for (const job of jobs) {
        const pos = this.findTopicInsertionPosition(
          editor,
          job.targetLine,
          job.targetHeading,
          job.targetConcept,
          job.targetQuery
        );
        plannedJobs.push({
          ...job,
          pos
        });
      }

      // 2. CRITICAL: Sort planned jobs in DESCENDING order of line number (bottom to top)
      plannedJobs.sort((a, b) => 
        (b.pos.line - a.pos.line) || 
        (b.suggestionIndex - a.suggestionIndex) || 
        ((b.subIndex || 0) - (a.subIndex || 0))
      );

      // 3. Download and insert each image bottom-to-top
      let insertedCount = 0;
      const successfulIndices = new Set();
      const failedIndices = new Set();
      for (let i = 0; i < plannedJobs.length; i++) {
        const job = plannedJobs[i];
        if (onProgress) onProgress(i + 1, plannedJobs.length);
        try {
          const item = job.imageItem;
          const image = await this.downloadImage(item);
          this.validateTarget(target);
          const hash = crypto.createHash('sha256').update(image.bytes).digest('hex').slice(0, 16);
          const fileName = `${safeFileName(item.title)}-${hash}.${image.ext}`;
          const fullPath = `${folderPath}/${fileName}`;

          const existing = this.app.vault.getAbstractFileByPath(fullPath);
          if (existing && !(existing instanceof TFile)) throw new Error('An attachment folder conflicts with the image filename.');
          if (!existing) {
            const binary = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength);
            try { await this.app.vault.createBinary(fullPath, binary); }
            catch (err) {
              const concurrent = this.app.vault.getAbstractFileByPath(fullPath);
              if (!(concurrent instanceof TFile)) throw err;
              const stored = Buffer.from(await this.app.vault.readBinary(concurrent));
              if (!stored.equals(image.bytes)) throw new Error('Attachment conflict; existing file was preserved.');
            }
          } else {
            const stored = Buffer.from(await this.app.vault.readBinary(existing));
            if (!stored.equals(image.bytes)) throw new Error('Attachment conflict; existing file was preserved.');
          }

          const markdown = this.generateImageMarkdown(editor, job.pos, fullPath, width, includeCaption, item);
          editor.replaceRange(markdown, job.pos);
          target.content = editor.getValue();
          insertedCount++;
          if (job.suggestionIndex != null) successfulIndices.add(job.suggestionIndex);
        } catch (err) {
          if (job.suggestionIndex != null) failedIndices.add(job.suggestionIndex);
          console.error(`Failed to batch insert image for ${job.targetConcept}:`, err);
        }
      }

      if (insertedCount === 0 && jobs.length > 0) {
        throw new Error(`Failed to insert any images into ${target.file.basename}. Check image sources or attachment folder.`);
      } else if (failedIndices.size > 0) {
        new Notice(`⚠️ Inserted ${insertedCount} of ${jobs.length} images into ${target.file.basename} (${failedIndices.size} failed).`, 6000);
      } else {
        new Notice(`✅ Successfully inserted ${insertedCount} images into ${target.file.basename}!`, 6000);
      }
      return { insertedCount, successfulIndices, failedIndices };
    };
    const pending = (this.writeQueue || Promise.resolve()).then(runBatch);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async ensureFolder(folderPath) {
    let current = '';
    for (const part of attachmentPath(folderPath).split('/')) {
      current = current ? `${current}/${part}` : part;
      let file = this.app.vault.getAbstractFileByPath(current);
      if (!file) {
        try { await this.app.vault.createFolder(current); }
        catch (err) {
          file = this.app.vault.getAbstractFileByPath(current);
          if (!file || file instanceof TFile) throw err;
        }
      } else if (file instanceof TFile) throw new Error(`A file blocks the attachment folder: ${current}`);
    }
  }


}

module.exports = MedicalImageFinderPlugin;
