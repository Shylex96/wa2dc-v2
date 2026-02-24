import discordJs from 'discord.js';
import { downloadMediaMessage, downloadContentFromMessage, prepareWAMessageMedia } from '@whiskeysockets/baileys';
import readline from 'readline';
import QRCode from 'qrcode';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns';
import net from 'net';
import { pipeline } from 'stream/promises';
import { pathToFileURL } from 'url';
import http from 'http';
import https from 'https';
import childProcess from 'child_process';
import * as linkPreview from 'link-preview-js';
import { Agent } from 'undici';

import state from './state.js';
import storage from './storage.js';
import messageStore from './messageStore.js';

const { Webhook, MessageAttachment, MessageActionRow, MessageButton, Constants: DiscordConstants } = discordJs;
const { StickerFormatTypes } = DiscordConstants;

const DOWNLOAD_TOKEN_VERSION = 1;
const CUSTOM_EMOJI_REGEX = /<(a?):([a-zA-Z0-9_]{1,32}):(\d+)>/g;
const GIF_URL_EXTENSION_REGEX = /\.(gif|mp4|webm)$/i;
const GIF_PROVIDER_HINTS = ['tenor', 'giphy', 'imgur', 'gyazo'];
const isKnownGifProvider = (value = '') => GIF_PROVIDER_HINTS.some((hint) => value.includes(hint));
const MIME_BY_EXTENSION = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  apng: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
};
const LINK_PREVIEW_FETCH_TIMEOUT_MS = 3000;
const LINK_PREVIEW_MAX_REDIRECTS = 5;
const LINK_PREVIEW_FETCH_OPTS = { timeout: LINK_PREVIEW_FETCH_TIMEOUT_MS };
const LINK_PREVIEW_MAX_BYTES = 1024 * 1024; // 1 MiB
const LINK_PREVIEW_THUMB_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const EXPLICIT_URL_REGEX = /<?https?:\/\/[^\s>]+>?/i;
const BARE_URL_REGEX = /(?:^|[\s<])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[\w\-./?%&=+#]*)?)/i;
const TRAILING_PUNCTUATION_REGEX = /[)\],.;!?]+$/;
// Constantes de actualizaciones comentadas - modo empresarial sin auto-actualizaciones
// const UPDATE_BUTTON_IDS = {
//   APPLY: 'wa2dc:update',
//   SKIP: 'wa2dc:skip-update',
// };
// const ROLLBACK_BUTTON_ID = 'wa2dc:rollback';
const resolveLinkPreviewFromContentFn = () => {
  const candidates = [
    linkPreview?.getPreviewFromContent,
    linkPreview?.default?.getPreviewFromContent,
    linkPreview?.['module.exports']?.getPreviewFromContent,
  ];
  return candidates.find((candidate) => typeof candidate === 'function') || null;
};
const getPreviewFromContentFn = resolveLinkPreviewFromContentFn();

const coercePositiveInt = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
};

const safeTimingEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const getDownloadServerSecretKey = () => {
  const secret = state.settings?.LocalDownloadServerSecret;
  if (typeof secret !== 'string' || !secret) return null;
  try {
    return Buffer.from(secret, 'base64url');
  } catch {
    return null;
  }
};

const ensureDownloadServerSecret = () => {
  const existing = getDownloadServerSecretKey();
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('base64url');
  state.settings.LocalDownloadServerSecret = secret;
  storage.saveSettings?.().catch(() => { });
  return Buffer.from(secret, 'base64url');
};

const getPrivacySaltKey = () => {
  const secret = state.settings?.PrivacySalt;
  if (typeof secret !== 'string' || !secret) return null;
  try {
    return Buffer.from(secret, 'base64url');
  } catch {
    return null;
  }
};

const ensurePrivacySaltKey = () => {
  const existing = getPrivacySaltKey();
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('base64url');
  state.settings.PrivacySalt = secret;
  storage.saveSettings?.().catch(() => { });
  return Buffer.from(secret, 'base64url');
};

const signDownloadTokenPayload = (payloadBase64) => {
  const secretKey = getDownloadServerSecretKey();
  if (!secretKey) return null;
  return crypto.createHmac('sha256', secretKey).update(payloadBase64).digest('base64url');
};

const buildDownloadToken = (fileName) => {
  const secretKey = ensureDownloadServerSecret();
  const ttl = coercePositiveInt(state.settings?.LocalDownloadLinkTTLSeconds);
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: DOWNLOAD_TOKEN_VERSION, f: fileName };
  if (ttl) {
    payload.e = now + ttl;
  }
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secretKey).update(payloadBase64).digest('base64url');
  return `${payloadBase64}.${signature}`;
};

const verifyDownloadToken = (token) => {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadBase64, signature] = parts;
  if (!payloadBase64 || !signature) return null;
  const expected = signDownloadTokenPayload(payloadBase64);
  if (!expected || !safeTimingEqual(expected, signature)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== DOWNLOAD_TOKEN_VERSION) return null;
  if (typeof payload.f !== 'string' || !payload.f) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.e != null) {
    const exp = Number(payload.e);
    if (!Number.isFinite(exp)) return null;
    if (now > exp) return { ...payload, expired: true };
  }
  return payload;
};

const normalizeHostname = (hostname = '') => hostname.replace(/\.$/, '').toLowerCase();

const ipv4ToInt = (addr) => {
  const parts = String(addr).split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
};

const isPrivateIPv4Int = (value) => {
  if (!Number.isInteger(value)) return true;
  const unsigned = value >>> 0;
  const first = unsigned >>> 24;
  const second = (unsigned >>> 16) & 0xff;

  if (first === 10) return true; // 10.0.0.0/8
  if (first === 127) return true; // 127.0.0.0/8 (loopback)
  if (first === 169 && second === 254) return true; // 169.254.0.0/16 (link-local)
  if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
  if (first === 192 && second === 168) return true; // 192.168.0.0/16
  if (first === 0) return true; // 0.0.0.0/8 (software)
  return false;
};

const isBlockedIp = (address = '') => {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    const asInt = ipv4ToInt(address);
    return isPrivateIPv4Int(asInt);
  }
  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
    if (normalized.startsWith('::ffff:')) {
      const tail = normalized.slice('::ffff:'.length);
      if (net.isIP(tail) === 4) return isBlockedIp(tail);
    }
    // fc00::/7 (unique local)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // fe80::/10 (link-local)
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    // ff00::/8 (multicast)
    if (normalized.startsWith('ff')) return true;
    return false;
  }
  return false;
};

const isBlockedHostname = (hostname = '') => {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  return false;
};

const pickSafeLookupResult = (results = [], familyPreference) => {
  const filtered = results
    .filter((entry) => entry && entry.address && !isBlockedIp(entry.address))
    .filter((entry) => (familyPreference ? entry.family === familyPreference : true));
  if (!filtered.length) return null;
  const ipv4 = filtered.find((entry) => entry.family === 4);
  return ipv4 || filtered[0];
};

const linkPreviewLookup = (hostname, options, callback) => {
  Promise.resolve()
    .then(async () => {
      const normalized = normalizeHostname(hostname);
      if (isBlockedHostname(normalized)) {
        throw new Error('Hostname bloqueado');
      }

      const ipVersion = net.isIP(normalized);
      const wantsAll = Boolean(options?.all);
      if (ipVersion) {
        if (isBlockedIp(normalized)) {
          throw new Error('Dirección IP bloqueada');
        }
        const entry = { address: normalized, family: ipVersion };
        return wantsAll ? [entry] : entry;
      }

      const family = options?.family === 4 || options?.family === 6 ? options.family : undefined;
      const results = await dns.promises.lookup(normalized, { all: true, verbatim: true });
      const filtered = results
        .filter((entry) => entry && entry.address && !isBlockedIp(entry.address))
        .filter((entry) => (family ? entry.family === family : true));
      if (!filtered.length) {
        throw new Error('No se resolvieron direcciones IP públicas para el host');
      }
      if (wantsAll) {
        return filtered;
      }
      const picked = pickSafeLookupResult(filtered);
      if (!picked) {
        throw new Error('No se resolvieron direcciones IP públicas para el host');
      }
      return picked;
    })
    .then((picked) => {
      if (Array.isArray(picked)) {
        callback(null, picked);
        return;
      }
      callback(null, picked.address, picked.family);
    })
    .catch((err) => callback(err));
};

const linkPreviewDispatcher = new Agent({
  connect: { lookup: linkPreviewLookup },
});

const isSafeUrlForPreviewFetch = async (candidate) => {
  if (!candidate) return false;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) return false;

  const ipVersion = net.isIP(hostname);
  if (ipVersion) {
    return !isBlockedIp(hostname);
  }

  let results;
  try {
    results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every((entry) => entry?.address && !isBlockedIp(entry.address));
};

const readBodyWithLimit = async (body, maxBytes) => {
  if (!body || typeof body.getReader !== 'function') {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength || value.length || 0;
      if (total > maxBytes) {
        const err = new Error('Respuesta demasiado grande');
        err.code = 'WA2DC_PREVIEW_TOO_LARGE';
        throw err;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks, total);
};

const validatePreviewTargetUrl = (candidate = '') => {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('URL inválida');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Protocolo de URL no soportado');
  }
  if (url.username || url.password) {
    throw new Error('Credenciales de URL bloqueadas');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error('Hostname bloqueado');
  }
  if (isBlockedIp(url.hostname)) {
    throw new Error('Dirección IP bloqueada');
  }
  return url;
};

const fetchPreviewResponse = async (url, { maxBytes = LINK_PREVIEW_MAX_BYTES } = {}) => {
  let currentUrl = url;
  let redirects = 0;
  const shouldFollowRedirect = createRedirectHandler();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    validatePreviewTargetUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINK_PREVIEW_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        dispatcher: linkPreviewDispatcher,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'WA2DC-LinkPreview',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      const status = Number(response.status) || 0;
      if (status >= 300 && status < 400) {
        const locationHeader = response.headers.get('location') || '';
        if (!locationHeader) {
          throw new Error('Redirección sin ubicación');
        }
        if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) {
          throw new Error('Demasiadas redirecciones');
        }
        const forwardedUrl = new URL(locationHeader, currentUrl).toString();
        if (!shouldFollowRedirect(currentUrl, forwardedUrl)) {
          throw new Error('Redirección bloqueada');
        }
        currentUrl = forwardedUrl;
        redirects += 1;
        continue;
      }

      if (status < 200 || status >= 300) {
        throw new Error(`Estado inesperado ${status}`);
      }

      const headers = {};
      response.headers.forEach((value, key) => {
        headers[String(key).toLowerCase()] = value;
      });

      const contentLength = Number(headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const err = new Error('Respuesta demasiado grande');
        err.code = 'WA2DC_PREVIEW_TOO_LARGE';
        throw err;
      }

      let data = '';
      const contentType = headers['content-type'] || '';
      const treatAsText = !contentType
        || /^text\//i.test(contentType)
        || /html|xml|json/i.test(contentType);
      if (treatAsText) {
        const buffer = await readBodyWithLimit(response.body, maxBytes);
        data = buffer.toString('utf8');
      }

      return {
        url: currentUrl,
        headers,
        data,
      };
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw new Error('Tiempo de espera agotado para la petición');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
};

const fetchPreviewBuffer = async (url, {
  maxBytes = LINK_PREVIEW_THUMB_MAX_BYTES,
  accept = 'image/*,*/*;q=0.8',
} = {}) => {
  let currentUrl = url;
  let redirects = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    validatePreviewTargetUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINK_PREVIEW_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        dispatcher: linkPreviewDispatcher,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'WA2DC-LinkPreview',
          accept,
        },
      });

      const status = Number(response.status) || 0;
      if (status >= 300 && status < 400) {
        const locationHeader = response.headers.get('location') || '';
        if (!locationHeader) {
          throw new Error('Redirección sin ubicación');
        }
        if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) {
          throw new Error('Demasiadas redirecciones');
        }
        currentUrl = new URL(locationHeader, currentUrl).toString();
        redirects += 1;
        continue;
      }

      if (status < 200 || status >= 300) {
        throw new Error(`Estado inesperado ${status}`);
      }

      const headers = {};
      response.headers.forEach((value, key) => {
        headers[String(key).toLowerCase()] = value;
      });

      const contentLength = Number(headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const err = new Error('Respuesta demasiado grande');
        err.code = 'WA2DC_PREVIEW_TOO_LARGE';
        throw err;
      }

      const buffer = await readBodyWithLimit(response.body, maxBytes);
      return { url: currentUrl, headers, buffer };
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw new Error('Tiempo de espera agotado para la petición');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
};

const sanitizeFileName = (name = '', fallback = 'file') => {
  const normalized = name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 64);
  return normalized || fallback;
};

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, idx) => `com${idx + 1}`),
  ...Array.from({ length: 9 }, (_, idx) => `lpt${idx + 1}`),
]);

const isWindowsReservedBasename = (value = '') => WINDOWS_RESERVED_BASENAMES.has(String(value).toLowerCase());

const sanitizePathSegment = (name = '', fallback = 'file') => {
  const raw = String(name)
    .replace(/[\\/]+/g, '-')
    .replace(/\0/g, '')
    .trim();
  const base = path.basename(raw);
  let normalized = base.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 128);

  // Windows disallows trailing dots/spaces, and reserved device names (even with extensions).
  normalized = normalized.replace(/[. ]+$/g, '');
  const parsed = path.parse(normalized);
  if (parsed.name && isWindowsReservedBasename(parsed.name)) {
    normalized = `_${parsed.name}${parsed.ext}`.slice(0, 128);
  }

  normalized = normalized.replace(/[. ]+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') {
    return fallback;
  }
  return normalized;
};

const guessExtensionFromUrl = (url = '') => {
  const match = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
  return match ? match[1].toLowerCase() : null;
};

const extensionToMime = (ext = '') => MIME_BY_EXTENSION[ext] || 'application/octet-stream';

const isSupportedGifUrl = (url = '') => GIF_URL_EXTENSION_REGEX.test(url);

const pickEmbedMediaUrl = (embed = {}) => {
  const candidates = [
    embed.video?.url,
    embed.video?.proxyURL,
    embed.image?.url,
    embed.image?.proxyURL,
    embed.thumbnail?.url,
    embed.thumbnail?.proxyURL,
  ].filter((candidate) => typeof candidate === 'string' && candidate.startsWith('http'));
  if (!candidates.length) {
    return null;
  }
  const supported = candidates.find((candidate) => isSupportedGifUrl(candidate));
  return supported || candidates[0] || null;
};

const dedupeAttachments = (attachments = []) => {
  const seen = new Set();
  return attachments.filter((attachment) => {
    const key = `${attachment?.url || ''}|${attachment?.name || ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const stripUrlDelimiters = (value = '') => value.replace(/^<+|>+$/g, '');
const stripTrailingPunctuation = (value = '') => value.replace(TRAILING_PUNCTUATION_REGEX, '');

const extractUrlCandidate = (text = '') => {
  if (!text) {
    return null;
  }
  const explicitMatch = text.match(EXPLICIT_URL_REGEX);
  if (explicitMatch) {
    return stripTrailingPunctuation(stripUrlDelimiters(explicitMatch[0]));
  }
  const bareMatch = text.match(BARE_URL_REGEX);
  if (bareMatch) {
    return stripTrailingPunctuation(bareMatch[1] || '');
  }
  return null;
};

const replaceFirstInstance = (text, search, replacement) => {
  if (!text || !search) {
    return text;
  }
  const index = text.indexOf(search);
  if (index === -1) {
    return text;
  }
  return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
};

const normalizePreviewUrl = (value = '') => {
  const trimmed = stripTrailingPunctuation(stripUrlDelimiters(value).trim());
  if (!trimmed) {
    return null;
  }
  const hasScheme = /^[a-z]+:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

const hostWithoutWww = (hostname = '') => hostname.replace(/^www\./, '');

const createRedirectHandler = () => {
  let redirects = 0;
  return (baseURL, forwardedURL) => {
    if (redirects >= LINK_PREVIEW_MAX_REDIRECTS) {
      return false;
    }
    try {
      const baseHost = hostWithoutWww(new URL(baseURL).hostname || '');
      const forwardedHost = hostWithoutWww(new URL(forwardedURL).hostname || '');
      if (baseHost && forwardedHost && baseHost === forwardedHost) {
        redirects += 1;
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };
};

const buildHighQualityThumbnail = async (imageUrl, uploadImage, fetchOpts = {}) => {
  if (typeof uploadImage !== 'function' || !imageUrl) {
    return {};
  }
  const safeToFetch = await isSafeUrlForPreviewFetch(imageUrl).catch(() => false);
  if (!safeToFetch) {
    state.logger?.warn({ imageUrl }, 'No se permitió la obtención de la imagen para la vista previa del enlace (protección contra ataques de tipo Server-Side Request Forgery)');
    return {};
  }
  try {
    const { buffer } = await fetchPreviewBuffer(imageUrl, { maxBytes: LINK_PREVIEW_THUMB_MAX_BYTES, accept: 'image/*,*/*;q=0.8' });

    let jpegThumbnail;
    try {
      const jimp = await import('jimp');
      if (typeof jimp?.Jimp?.read === 'function') {
        const img = await jimp.Jimp.read(buffer);
        const width = 192;
        jpegThumbnail = await img
          .resize({ w: width, mode: jimp.ResizeStrategy.BILINEAR })
          .getBuffer('image/jpeg', { quality: 50 });
      }
    } catch (err) {
      state.logger?.debug?.({ err }, 'No se pudo generar una miniatura de vínculo en formato JPEG');
    }

    const { imageMessage } = await prepareWAMessageMedia({ image: buffer }, {
      upload: uploadImage,
      mediaTypeOverride: 'thumbnail-link',
      options: fetchOpts,
    });
    if (!imageMessage) {
      return {};
    }
    if (!jpegThumbnail && imageMessage.jpegThumbnail) {
      jpegThumbnail = Buffer.from(imageMessage.jpegThumbnail);
    }
    return {
      jpegThumbnail,
      highQualityThumbnail: imageMessage,
    };
  } catch (err) {
    state.logger?.warn({ err, imageUrl }, 'No se pudo subir la miniatura de alta calidad para la vista previa');
    return {};
  }
};

const buildLinkPreviewInfo = async (text, { uploadImage, logger } = {}) => {
  const matchedText = extractUrlCandidate(text);
  if (!matchedText || !getPreviewFromContentFn) {
    return undefined;
  }
  const normalizedUrl = normalizePreviewUrl(matchedText);
  if (!normalizedUrl) {
    return undefined;
  }

  let preview;
  try {
    const response = await fetchPreviewResponse(normalizedUrl);
    preview = await getPreviewFromContentFn(response, {});
  } catch (err) {
    if (!err?.message?.includes('receive a valid response')) {
      logger?.warn({ err, url: normalizedUrl }, 'No se pudo obtener la vista previa del enlace');
    }
    return undefined;
  }

  if (!preview) {
    return undefined;
  }

  const urlInfo = {
    'canonical-url': preview.url || normalizedUrl,
    'matched-text': matchedText,
  };

  if (preview.title) {
    urlInfo.title = preview.title;
  }
  if (preview.description) {
    urlInfo.description = preview.description;
  }

  const images = Array.isArray(preview.images) ? preview.images : [];
  const firstImage = images.find((imageUrl) => {
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) return false;
    try {
      const url = new URL(imageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (isBlockedHostname(url.hostname)) return false;
      if (isBlockedIp(url.hostname)) return false;
      return true;
    } catch {
      return false;
    }
  });
  if (firstImage) {
    urlInfo.originalThumbnailUrl = firstImage;
    if (typeof uploadImage === 'function') {
      const { jpegThumbnail, highQualityThumbnail } = await buildHighQualityThumbnail(firstImage, uploadImage, LINK_PREVIEW_FETCH_OPTS);
      if (jpegThumbnail) {
        urlInfo.jpegThumbnail = jpegThumbnail;
      }
      if (highQualityThumbnail) {
        urlInfo.highQualityThumbnail = highQualityThumbnail;
      }
    }
  }

  return urlInfo;
};

function ensureWebhookReplySupport(webhook) {
  if (!webhook) return webhook;
  if (webhook.messages && typeof webhook.messages.resolveId === 'function') {
    return webhook;
  }

  const cloneArray = (value) => (Array.isArray(value) ? [...value] : value);
  webhook.messages = {
    resolveId(reference) {
      if (!reference) return null;
      if (typeof reference === 'string' || typeof reference === 'number') {
        return String(reference);
      }
      if (typeof reference === 'object') {
        if ('id' in reference && reference.id) {
          return String(reference.id);
        }
        if ('message_id' in reference && reference.message_id) {
          return String(reference.message_id);
        }
        if ('messageId' in reference && reference.messageId) {
          return String(reference.messageId);
        }
        if ('message' in reference && reference.message?.id) {
          return String(reference.message.id);
        }
      }
      return null;
    },
  };

  if (webhook.client && webhook.client.options) {
    const { allowedMentions } = webhook.client.options;
    if (allowedMentions) {
      webhook._wa2dcAllowedMentions = {
        ...allowedMentions,
        parse: cloneArray(allowedMentions.parse),
        roles: cloneArray(allowedMentions.roles),
        users: cloneArray(allowedMentions.users),
      };
    }
  }

  return webhook;
}

function ensureDownloadServer() {
  if (!state.settings.LocalDownloadServer || ensureDownloadServer.server) return;

  const bindHost = state.settings.LocalDownloadServerBindHost || '0.0.0.0';

  const handler = (req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Método no permitido');
        return;
      }

      const requestUrl = new URL(req.url, 'http://localhost');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const token = segments[0] || '';
      const verification = verifyDownloadToken(token);
      if (!verification || verification.expired) {
        res.writeHead(404);
        res.end('No encontrado');
        return;
      }
      const resolvedDownloadDir = path.resolve(state.settings.DownloadDir);
      const fileName = sanitizePathSegment(verification.f, 'file');
      const filePath = path.resolve(resolvedDownloadDir, fileName);
      const relative = path.relative(resolvedDownloadDir, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(404);
        res.end('No encontrado');
        return;
      }
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        res.writeHead(404);
        res.end('No encontrado');
        return;
      }
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end('No encontrado');
        return;
      }

      const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
      const mime = extensionToMime(ext);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Accept-Ranges', 'bytes');

      const totalSize = stat.size;
      const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
      const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      const wantsRange = Boolean(rangeHeader);
      if (wantsRange && !rangeMatch) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }

      let start = 0;
      let end = totalSize - 1;
      let status = 200;

      if (rangeMatch) {
        const startRaw = rangeMatch[1];
        const endRaw = rangeMatch[2];
        const startNum = startRaw ? Number.parseInt(startRaw, 10) : null;
        const endNum = endRaw ? Number.parseInt(endRaw, 10) : null;

        if (startNum == null && endNum == null) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }

        if (startNum == null) {
          const suffixLength = endNum;
          if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
            res.end();
            return;
          }
          start = Math.max(totalSize - suffixLength, 0);
          end = totalSize - 1;
        } else {
          start = startNum;
          end = endNum == null ? totalSize - 1 : endNum;
          if (end >= totalSize) {
            end = totalSize - 1;
          }
        }

        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }

        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      }

      const contentLength = end - start + 1;
      res.setHeader('Content-Length', String(contentLength));
      res.writeHead(status);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(filePath, status === 206 ? { start, end } : undefined);
      stream.on('error', () => {
        res.destroy();
      });
      stream.pipe(res);
    })().catch(() => {
      res.writeHead(500);
      res.end('Error interno del servidor');
    });
  };

  const handleServerError = (err) => {
    state.logger?.error(err);
    ensureDownloadServer.server = null;
  };

  try {
    const shouldUseHttps = (
      state.settings.UseHttps &&
      state.settings.HttpsKeyPath &&
      state.settings.HttpsCertPath &&
      fs.existsSync(state.settings.HttpsKeyPath) &&
      fs.existsSync(state.settings.HttpsCertPath)
    );

    if (shouldUseHttps) {
      const options = {
        key: fs.readFileSync(state.settings.HttpsKeyPath),
        cert: fs.readFileSync(state.settings.HttpsCertPath),
      };
      ensureDownloadServer.server = https.createServer(options, handler);
      ensureDownloadServer.protocol = 'https';
    } else {
      ensureDownloadServer.server = http.createServer(handler);
      ensureDownloadServer.protocol = 'http';
    }

    ensureDownloadServer.server.on('error', handleServerError);
    ensureDownloadServer.server.listen(state.settings.LocalDownloadServerPort, bindHost);
  } catch (err) {
    handleServerError(err);
  }
}

function stopDownloadServer() {
  if (ensureDownloadServer.server) {
    ensureDownloadServer.server.close();
    ensureDownloadServer.server = null;
    ensureDownloadServer.protocol = null;
  }
}

// Comentado - modo empresarial sin actualizaciones
// const sqliteToJson = {
//   get defaultExeName() {
//     let name = 'stj_';
//     let osPlatform = os.platform()

//     switch (osPlatform) {
//       case 'linux':
//       case 'darwin':
//       case 'freebsd':
//         name += osPlatform + "_";
//         break;
//       case 'win32':
//         name += 'windows_';
//         break;
//       default:
//         return '';
//     }

//     switch (process.arch) {
//       case 'arm':
//       case 'arm64':
//         name += process.arch;
//         break;
//       case 'x64':
//         name += 'amd64';
//         break;
//       default:
//         return '';
//     }

//     if (osPlatform === 'win32') {
//       name += '.exe'
//     }
//     return name;
//   },

//   _storageDir: './storage/',
//   _dbPath: './storage.db',
//   isConverted() {
//     return fs.existsSync(this._storageDir) || !fs.existsSync(this._dbPath);
//   },

//   runStj(exeName) {
//     fs.mkdirSync(this._storageDir, { recursive: true, mode: 0o700 });
//     const exePath = path.resolve(exeName);

//     const child = childProcess.spawnSync(exePath, [this._dbPath, 'SELECT * FROM WA2DC'], { shell: false });
//     if (child.error) {
//       throw child.error;
//     }
//     if (typeof child.status === 'number' && child.status !== 0) {
//       const stderr = child.stderr ? child.stderr.toString() : '';
//       throw new Error(`El convertidor de base de datos falló (salida ${child.status})${stderr ? `: ${stderr}` : ''}`);
//     }

//     const allowedKeys = new Set(['settings', 'chats', 'contacts', 'lastMessages', 'lastTimestamp']);
//     const raw = child.stdout ? child.stdout.toString().trim() : '';
//     if (!raw) {
//       return;
//     }

//     const rows = raw.split('\n');
//     for (const line of rows) {
//       if (!line) continue;
//       const row = JSON.parse(line);
//       const key = sanitizePathSegment(row?.[0] ?? '', '');
//       if (!key || !allowedKeys.has(key)) {
//         state.logger?.warn({ key: row?.[0] }, 'Omitiendo clave de almacenamiento inesperada durante la migración de la base de datos');
//         continue;
//       }
//       fs.writeFileSync(path.join(this._storageDir, key), row?.[1] ?? '', { mode: 0o600 });
//     }
//   },
// }

const discord = {
  // updateButtonIds: UPDATE_BUTTON_IDS, // Comentado - modo empresarial sin actualizaciones
  // rollbackButtonId: ROLLBACK_BUTTON_ID, // Comentado - modo empresarial sin actualizaciones
  channelIdToJid(channelId) {
    return Object.keys(state.chats).find((key) => state.chats[key].channelId === channelId);
  },
  partitionText(text) {
    return text.match(/(.|[\r\n]){1,2000}/g) || [];
  },
  async sendPartitioned(channel, text) {
    if (!channel || !text) return;
    const parts = this.partitionText(text);
    for (const part of parts) {
      // eslint-disable-next-line no-await-in-loop
      await channel.send(part);
    }
  },
  stripCustomEmojiCodes(text = '') {
    if (!text) return '';
    return text.replace(CUSTOM_EMOJI_REGEX, ' ').replace(/  +/g, ' ');
  },
  ensureExplicitUrlScheme(text = '') {
    const candidate = extractUrlCandidate(text);
    if (!candidate) {
      return { text, matched: null, normalized: null };
    }
    const normalized = normalizePreviewUrl(candidate);
    if (!normalized || normalized === candidate) {
      return { text, matched: candidate, normalized: normalized || candidate };
    }
    const variants = [candidate, `<${candidate}>`];
    let updated = text;
    for (const variant of variants) {
      const next = replaceFirstInstance(updated, variant, normalized);
      if (next !== updated) {
        updated = next;
        break;
      }
    }
    return { text: updated, matched: candidate, normalized };
  },
  extractCustomEmojiData(message) {
    const content = message?.content ?? '';
    if (!content) {
      return { matches: [], rawWithoutEmoji: '' };
    }
    const matches = [...content.matchAll(CUSTOM_EMOJI_REGEX)].map(([, animatedFlag, name, id]) => ({
      animated: animatedFlag === 'a',
      name,
      id,
    }));
    const rawWithoutEmoji = content.replace(CUSTOM_EMOJI_REGEX, ' ');
    return { matches, rawWithoutEmoji };
  },
  buildCustomEmojiAttachments(matches = []) {
    if (!matches.length) return [];
    const unique = new Map();
    for (const entry of matches) {
      if (!entry?.id || unique.has(entry.id)) continue;
      const extension = entry.animated ? 'gif' : 'png';
      unique.set(entry.id, {
        url: `https://cdn.discordapp.com/emojis/${entry.id}.${extension}?quality=lossless`,
        name: `${sanitizeFileName(entry.name || 'emoji', 'emoji')}-${entry.id}.${extension}`,
        contentType: extensionToMime(extension),
      });
    }
    return [...unique.values()];
  },
  _buildStickerAttachment(sticker) {
    const id = sticker?.id;
    if (!id) return null;
    const format = sticker?.format;
    let extension = 'png';
    let baseUrl = `https://media.discordapp.net/stickers/${id}`;
    if (format === StickerFormatTypes.GIF) {
      extension = 'gif';
    }
    const url = `${baseUrl}.${extension}${extension === 'png' ? '?size=320' : ''}`;
    return {
      url,
      name: `${sanitizeFileName(sticker?.name || 'sticker', 'sticker')}-${id}.${extension}`,
      contentType: extensionToMime(extension),
    };
  },
  collectStickerAttachments(message) {
    const stickers = message?.stickers;
    if (!stickers?.size) return [];
    const attachments = [];
    const seen = new Set();
    for (const sticker of stickers.values()) {
      if (!sticker || !sticker.id || seen.has(sticker.id)) continue;
      const attachment = this._buildStickerAttachment(sticker);
      if (attachment) {
        seen.add(sticker.id);
        attachments.push(attachment);
      }
    }
    return attachments;
  },
  extractGifEmbedAttachments(message) {
    const embeds = message?.embeds;
    if (!Array.isArray(embeds) || !embeds.length) return [];
    const attachments = [];
    for (const embed of embeds) {
      const mediaUrl = pickEmbedMediaUrl(embed);
      if (!mediaUrl || !isSupportedGifUrl(mediaUrl)) continue;
      const extension = guessExtensionFromUrl(mediaUrl) || 'gif';
      const baseName = embed?.title || embed?.provider?.name || 'discord-gif';
      const shareCandidate = (embed?.url || '').toLowerCase();
      const providerCandidate = (embed?.provider?.name || '').toLowerCase();
      const shouldConsumeUrl = isKnownGifProvider(shareCandidate) || isKnownGifProvider(providerCandidate);
      attachments.push({
        attachment: {
          url: mediaUrl,
          name: `${sanitizeFileName(baseName, 'discord-gif')}.${extension}`,
          contentType: extensionToMime(extension),
        },
        sourceUrl: shouldConsumeUrl ? embed?.url : null,
      });
    }
    return attachments;
  },
  collectMessageMedia(message, { includeEmojiAttachments = false, emojiMatches = [] } = {}) {
    const baseAttachments = message?.attachments?.size ? [...message.attachments.values()] : [];
    const stickerAttachments = this.collectStickerAttachments(message);
    const gifEmbeds = this.extractGifEmbedAttachments(message);
    const emojiAttachments = includeEmojiAttachments ? this.buildCustomEmojiAttachments(emojiMatches) : [];
    const consumedUrls = gifEmbeds.map((entry) => entry.sourceUrl).filter(Boolean);
    const combined = dedupeAttachments([
      ...baseAttachments,
      ...stickerAttachments,
      ...gifEmbeds.map((entry) => entry.attachment),
      ...emojiAttachments,
    ]);
    return { attachments: combined, consumedUrls };
  },
  convertWhatsappFormatting(text = '') {
    if (!text) return text;
    let converted = text;
    converted = converted.replace(/_\*(.+?)\*_/g, '***$1***');
    converted = converted.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '**$1**');
    converted = converted.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '*$1*');
    converted = converted.replace(/~(.+?)~/g, '~~$1~~');
    return converted;
  },
  async generateLinkPreview(text, { uploadImage, logger } = {}) {
    return buildLinkPreviewInfo(text, { uploadImage, logger });
  },
  async getGuild() {
    if (!state.dcClient) return null;
    if (!state.settings?.GuildID) return null;
    return state.dcClient.guilds.fetch(state.settings.GuildID).catch((err) => { state.logger?.error(err) });
  },
  async getChannel(channelID) {
    const guild = await this.getGuild();
    if (!guild) return null;
    return guild.channels.fetch(channelID).catch((err) => { state.logger?.error(err) });
  },
  async getCategory(nthChannel) {
    const guild = await this.getGuild();
    await guild.channels.fetch();

    if (!Array.isArray(state.settings.Categories)) {
      state.settings.Categories = [];
    }

    let nthCategory = Math.floor((nthChannel + 1) / 50);

    // Keep searching until a valid or new category is available.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (state.settings.Categories[nthCategory] == null) {
        const categoryName = `whatsapp ${nthCategory + 1}`;
        const category = await guild.channels.create(categoryName, { type: 'GUILD_CATEGORY' });
        state.settings.Categories[nthCategory] = category.id;
        continue;
      }

      const categoryId = state.settings.Categories[nthCategory];
      const category = guild.channels.cache.get(categoryId);

      if (!category) {
        state.settings.Categories.splice(nthCategory, 1);
        continue;
      }

      const childCount = guild.channels.cache.filter((channel) => channel.parentId === categoryId).size;

      if (childCount >= 50) {
        nthCategory += 1;
        continue;
      }

      return categoryId;
    }
  },
  async createChannel(name) {
    const guild = await this.getGuild();
    if (!guild) return null;
    return guild.channels.create(name, {
      type: 'GUILD_TEXT',
      parent: await this.getCategory(Object.keys(state.chats).length + this._unfinishedGoccCalls),
    });
  },
  _unfinishedGoccCalls: 0,
  async getOrCreateChannel(jid) {
    const normalizedJid = whatsapp.formatJid(jid);
    if (!normalizedJid) return null;
    if (state.goccRuns[normalizedJid]) { return state.goccRuns[normalizedJid]; }
    let resolve;
    state.goccRuns[normalizedJid] = new Promise((res) => {
      resolve = res;
    });
    if (state.chats[normalizedJid]) {
      const webhook = ensureWebhookReplySupport(new Webhook(state.dcClient, state.chats[normalizedJid]));
      resolve(webhook);
      return webhook;
    }

    this._unfinishedGoccCalls++;
    const name = whatsapp.jidToChannelName(normalizedJid);
    const channel = await this.createChannel(name).catch((err) => {
      if (err.code === 50035) {
        return this.createChannel('invalid-name');
      }
      throw err;
    });
    const webhook = ensureWebhookReplySupport(await channel.createWebhook('WA2DC'));
    state.chats[normalizedJid] = {
      id: webhook.id,
      type: webhook.type,
      token: webhook.token,
      channelId: webhook.channelId,
    };
    this._unfinishedGoccCalls--;
    resolve(webhook);
    return webhook;
  },
  async safeWebhookSend(webhook, args, jid) {
    const normalizeWebhookUsername = (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
    };

    if (args && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, 'username')) {
      const normalized = normalizeWebhookUsername(args.username);
      if (normalized == null) {
        // Avoid sending invalid webhook username (Discord rejects empty/whitespace usernames).
        args = { ...args };
        delete args.username;
      } else if (normalized !== args.username) {
        args = { ...args, username: normalized };
      }
    }

    const configuredRetriesRaw = state.settings?.DiscordUploadRetryAttempts;
    const configuredRetries = Number(configuredRetriesRaw);
    const maxAbortRetries = Number.isFinite(configuredRetries) && configuredRetries >= 1
      ? Math.floor(configuredRetries)
      : 3;

    const isAbortError = (err) =>
      err?.name === 'AbortError'
      || err?.name === 'AbortError2'
      || err?.code === 'ABORT_ERR'
      || /aborted/i.test(err?.message || '');

    const extractFileNames = (files) => {
      if (!Array.isArray(files)) return [];
      return files
        .map((file, index) => {
          if (!file) return null;
          if (typeof file === 'string') return file;
          if (Buffer.isBuffer(file)) return `Attachment ${index + 1}`;
          return file.name
            || file.attachment?.name
            || file.attachment?.filename
            || (typeof file.attachment?.path === 'string' ? path.basename(file.attachment.path) : null)
            || `Attachment ${index + 1}`;
        })
        .filter(Boolean);
    };

    const snapshotFileForRetry = (file) => {
      if (file == null || typeof file === 'number') {
        return { type: 'raw', data: file, retryable: true };
      }
      if (typeof file === 'string' || Buffer.isBuffer(file)) {
        return { type: 'raw', data: file, retryable: true };
      }

      const { attachment, file: fileProp, ...rest } = file;
      const snapshotBase = {
        rest,
        includeFileProperty: typeof fileProp !== 'undefined',
      };

      if (attachment == null) {
        return { ...snapshotBase, type: 'object', retryable: true };
      }
      if (typeof attachment === 'string' || Buffer.isBuffer(attachment)) {
        return { ...snapshotBase, type: 'buffer', data: attachment, retryable: true };
      }
      if (attachment && typeof attachment.path === 'string') {
        return { ...snapshotBase, type: 'path', path: attachment.path, retryable: true };
      }
      if (rest.downloadCtx) {
        return { ...snapshotBase, type: 'wa', retryable: true };
      }
      if (typeof attachment.pipe === 'function') {
        return { ...snapshotBase, type: 'stream', retryable: false };
      }
      return { ...snapshotBase, type: 'unknown', data: attachment, retryable: false };
    };

    const recreateFileFromSnapshot = async (snapshot) => {
      switch (snapshot.type) {
        case 'raw':
          return snapshot.data;
        case 'object': {
          const base = { ...snapshot.rest };
          if (snapshot.includeFileProperty) {
            base.file = base.attachment;
          }
          return base;
        }
        case 'buffer': {
          const base = { ...snapshot.rest, attachment: snapshot.data };
          if (snapshot.includeFileProperty) {
            base.file = base.attachment;
          }
          return base;
        }
        case 'path': {
          try {
            const attachment = fs.createReadStream(snapshot.path);
            const base = { ...snapshot.rest, attachment };
            if (snapshot.includeFileProperty) {
              base.file = attachment;
            }
            return base;
          } catch (error) {
            const retryError = new Error(`No se pudo recrear el archivo adjunto desde la ruta: ${snapshot.path}`);
            retryError.cause = error;
            retryError.wa2dcAttachmentRebuildFailed = true;
            throw retryError;
          }
        }
        case 'wa': {
          try {
            const attachment = await downloadMediaMessage(
              snapshot.rest.downloadCtx,
              'stream',
              {},
              {
                logger: state.logger,
                reuploadRequest: state.waClient.updateMediaMessage,
              },
            );
            const base = { ...snapshot.rest, attachment };
            if (snapshot.includeFileProperty) {
              base.file = attachment;
            }
            return base;
          } catch (error) {
            const retryError = new Error('No se pudo volver a descargar el medio de WhatsApp para reintentar');
            retryError.cause = error;
            retryError.wa2dcAttachmentRebuildFailed = true;
            throw retryError;
          }
        }
        case 'stream':
        case 'unknown': {
          const retryError = new Error('El archivo adjunto no se puede reintentar porque el stream original no se puede reconstruir');
          retryError.wa2dcAttachmentRebuildFailed = true;
          throw retryError;
        }
        default:
          return snapshot.data ?? null;
      }
    };

    const { files: originalFiles, ...restArgs } = args;
    const baseArgsWithoutFiles = { ...restArgs };
    const hasFilesArray = Array.isArray(originalFiles);
    const fileSnapshots = hasFilesArray ? originalFiles.map(snapshotFileForRetry) : null;
    const attachmentsRetryable = !fileSnapshots || fileSnapshots.every((snapshot) => snapshot.retryable !== false);

    const buildArgsFromSnapshots = async () => {
      const builtArgs = { ...baseArgsWithoutFiles };
      if (hasFilesArray) {
        const rebuiltFiles = await Promise.all(fileSnapshots.map(recreateFileFromSnapshot));
        if (rebuiltFiles.some((file) => file == null)) {
          const retryError = new Error('Falló la reconstrucción de uno o más archivos adjuntos para reintentar');
          retryError.wa2dcAttachmentRebuildFailed = true;
          throw retryError;
        }
        builtArgs.files = rebuiltFiles;
      }
      return builtArgs;
    };

    let attempt = 0;
    let attemptsMade = 0;
    let useOriginalFiles = true;
    let lastAbortError = null;

    while (attempt < maxAbortRetries) {
      let sendArgs;
      try {
        sendArgs = useOriginalFiles ? args : await buildArgsFromSnapshots();
      } catch (prepErr) {
        attemptsMade = attempt + 1;
        if (prepErr.wa2dcAttachmentRebuildFailed) {
          lastAbortError = prepErr;
          break;
        }
        throw prepErr;
      }
      useOriginalFiles = false;

      try {
        return await webhook.send(sendArgs);
      } catch (err) {
        attemptsMade = attempt + 1;
        if (err.code === 10015 && err.message.includes('Webhook desconocido')) {
          delete state.goccRuns[jid];
          const chatInfo = state.chats[jid];
          if (!chatInfo?.channelId) {
            throw err;
          }
          const channel = await this.getChannel(chatInfo.channelId);
          webhook = ensureWebhookReplySupport(await channel.createWebhook('WA2DC'));
          state.chats[jid] = {
            id: webhook.id,
            type: webhook.type,
            token: webhook.token,
            channelId: webhook.channelId,
          };
          attempt += 1;
          continue;
        }
        if (err.code === 40005 || err.httpStatus === 413) {
          const content = `Atención WA2DC: Se recibió un archivo, pero excede el límite de subida de Discord. Verifique WhatsApp en su teléfono${state.settings.LocalDownloads ? '' : ' o active las descargas locales.'}`;
          const fallbackArgs = {
            ...baseArgsWithoutFiles,
            content,
          };
          if (hasFilesArray) {
            fallbackArgs.files = [];
          }
          return await webhook.send(fallbackArgs);
        }
        if (err.wa2dcAttachmentRebuildFailed) {
          lastAbortError = err;
          break;
        }
        if (isAbortError(err)) {
          lastAbortError = err;
          state.logger?.warn({ err, attempt: attempt + 1 }, 'La solicitud del webhook de Discord fue abortada.');
          if (!attachmentsRetryable) {
            state.logger?.warn('Los archivos adjuntos no se pueden reintentar porque sus fuentes no son reproducibles. Enviando mensaje de respaldo.');
            break;
          }
          attempt += 1;
          if (attempt >= maxAbortRetries) {
            break;
          }
          continue;
        }
        throw err;
      }
    }

    const attemptsForMessage = Math.max(attemptsMade, lastAbortError ? 1 : 0) || 1;
    const fileNames = extractFileNames(originalFiles);
    const attemptText = ` después de ${attemptsForMessage} intento${attemptsForMessage === 1 ? '' : 's'}`;
    const attachmentNotice = fileNames.length
      ? ` Discord abortó la subida${attemptText} para: ${fileNames.join(', ')}.`
      : ` Discord abortó la subida${attemptText}.`;
    const originalContent = typeof args.content === 'string' ? args.content.trim() : '';
    const fallbackParts = [];
    if (originalContent) {
      fallbackParts.push(originalContent);
    }
    fallbackParts.push(`Atención WA2DC:${attachmentNotice} Por favor verifique WhatsApp para el mensaje original.`);
    const fallbackContent = fallbackParts.join('\n\n');
    const fallbackArgs = {
      ...baseArgsWithoutFiles,
      content: fallbackContent,
    };
    if (hasFilesArray) {
      fallbackArgs.files = [];
    }
    state.logger?.error({ err: lastAbortError, attempts: attemptsForMessage }, 'La solicitud del webhook de Discord fue abortada repetidamente; enviando mensaje de respaldo.');
    return await webhook.send(fallbackArgs);
  },
  async safeWebhookEdit(webhook, messageId, args, jid) {
    const normalizedJid = whatsapp.formatJid(jid);
    try {
      return await webhook.editMessage(messageId, args);
    } catch (err) {
      if (err.code === 10008 && err.message.includes('Mensaje desconocido')) {
        // message was already deleted or never existed
        return null;
      }
      if (err.code === 10015 && err.message.includes('Webhook desconocido')) {
        if (normalizedJid) {
          delete state.goccRuns[normalizedJid];
        }
        const channel = await this.getChannel(state.chats[normalizedJid]?.channelId);
        webhook = ensureWebhookReplySupport(await channel.createWebhook('WA2DC'));
        if (normalizedJid) {
          state.chats[normalizedJid] = {
            id: webhook.id,
            type: webhook.type,
            token: webhook.token,
            channelId: webhook.channelId,
          };
        }
        return await webhook.editMessage(messageId, args);
      }
      throw err;
    }
  },
  async safeWebhookDelete(webhook, messageId, jid) {
    const normalizedJid = whatsapp.formatJid(jid);
    try {
      return await webhook.deleteMessage(messageId);
    } catch (err) {
      if (err.code === 10008 && err.message.includes('Mensaje desconocido')) {
        // message was already removed, treat as success
        return null;
      }
      if (err.code === 10015 && err.message.includes('Webhook desconocido')) {
        if (normalizedJid) {
          delete state.goccRuns[normalizedJid];
        }
        const channel = await this.getChannel(state.chats[normalizedJid]?.channelId);
        webhook = ensureWebhookReplySupport(await channel.createWebhook('WA2DC'));
        if (normalizedJid) {
          state.chats[normalizedJid] = {
            id: webhook.id,
            type: webhook.type,
            token: webhook.token,
            channelId: webhook.channelId,
          };
        }
        return await webhook.deleteMessage(messageId);
      }
      throw err;
    }
  },
  async repairChannels() {
    const guild = await this.getGuild();
    await guild.channels.fetch();

    if (state.settings.Categories == null) {
      state.settings.Categories = [state.settings.CategoryID];
    }
    const categoryExists = await guild.channels.fetch(state.settings.Categories?.[0]).catch(() => null);
    const controlExists = await guild.channels.fetch(state.settings.ControlChannelID).catch(() => null);

    if (!categoryExists) {
      state.settings.Categories[0] = (
        await guild.channels.create('whatsapp', {
          type: 'GUILD_CATEGORY',
        })
      ).id;
    }

    if (!controlExists) {
      state.settings.ControlChannelID = (await this.createChannel('sala-de-control')).id;
    }

    await (await guild.channels.fetch(state.settings.ControlChannelID)).edit({
      position: 0,
      parent: state.settings.Categories[0],
    });
    for (const [jid, webhook] of Object.entries(state.chats)) {
      guild.channels.fetch(webhook.channelId).catch(() => {
        delete state.chats[jid];
      });
    }

    for await (const categoryId of state.settings.Categories) {
      const category = await guild.channels.fetch(categoryId).catch(() => null);
      if (category == null) { state.settings.Categories = state.settings.Categories.filter((id) => categoryId !== id); }
    }

    for (const [, channel] of guild.channels.cache) {
      if (channel.id !== state.settings.ControlChannelID && state.settings.Categories.includes(channel.parentId) && !this.channelIdToJid(channel.id)) {
        channel.edit({ parent: null });
      }
    }
  },
  async renameChannels() {
    const guild = await this.getGuild();

    for (const [jid, webhook] of Object.entries(state.chats)) {
      try {
        const channel = await guild.channels.fetch(webhook.channelId);
        await channel.edit({
          name: whatsapp.jidToName(jid),
        });
      } catch (err) {
        state.logger?.error(err);
      }
    }
  },
  async getControlChannel() {
    let channel = await this.getChannel(state.settings.ControlChannelID);
    if (!channel) {
      channel = await this.createChannel('sala-de-control');
      if (!channel) return null;
      state.settings.ControlChannelID = channel.id;
      await channel.edit({
        position: 0,
        parent: await this.getCategory(0),
      });
    }
    return channel;
  },
  // Función _fetchUpdatePromptMessage comentada - modo empresarial sin actualizaciones
  // async _fetchUpdatePromptMessage() {
  //   const ref = state.settings.UpdatePromptMessage;
  //   if (!ref?.messageId) {
  //     return null;
  //   }
  //   const channelId = ref.channelId || state.settings.ControlChannelID;
  //   try {
  //     const channel = await this.getChannel(channelId);
  //     if (!channel) {
  //       state.settings.UpdatePromptMessage = null;
  //       return null;
  //     }
  //     const message = await channel.messages.fetch(ref.messageId);
  //     return message;
  //   } catch (err) {
  //     state.logger?.debug?.({ err }, 'No se pudo obtener el mensaje de actualización almacenado');
  //     state.settings.UpdatePromptMessage = null;
  //     return null;
  //   }
  // },
  // Funciones de actualización comentadas - modo empresarial sin auto-actualizaciones
  // async ensureUpdatePrompt(updateInfo) {
  //   if (!updateInfo) {
  //     await this.clearUpdatePrompt();
  //     return;
  //   }
  //   const content = updater.formatUpdateMessage(updateInfo);
  //   const components = [
  //     new MessageActionRow().addComponents(
  //       new MessageButton()
  //         .setCustomId(UPDATE_BUTTON_IDS.APPLY)
  //         .setLabel('Update')
  //         .setStyle('PRIMARY')
  //         .setDisabled(!updateInfo.canSelfUpdate),
  //       new MessageButton()
  //         .setCustomId(UPDATE_BUTTON_IDS.SKIP)
  //         .setLabel('Skip update')
  //         .setStyle('SECONDARY'),
  //     ),
  //   ];

  //   let message = await this._fetchUpdatePromptMessage();
  //   if (message) {
  //     await message.edit({ content, components });
  //     return;
  //   }

  //   const channel = await this.getControlChannel();
  //   if (!channel) {
  //     return;
  //   }
  //   message = await channel.send({ content, components });
  //   state.settings.UpdatePromptMessage = {
  //     channelId: channel.id,
  //     messageId: message.id,
  //   };
  //   try {
  //     await storage.save();
  //   } catch (err) {
  //     state.logger?.warn({ err }, 'Error al persistir los metadatos del mensaje de actualización');
  //   }
  // },
  // Función clearUpdatePrompt comentada - modo empresarial sin actualizaciones
  // async clearUpdatePrompt() {
  //   const ref = state.settings.UpdatePromptMessage;
  //   const hadStoredMessage = Boolean(ref);
  //   if (ref?.messageId) {
  //     const message = await this._fetchUpdatePromptMessage();
  //     await message?.delete().catch(() => {});
  //   }
  //   state.settings.UpdatePromptMessage = null;
  //   if (hadStoredMessage) {
  //     try {
  //       await storage.save();
  //     } catch (err) {
  //       state.logger?.warn({ err }, 'No se pudo persistir los metadatos del mensaje de actualización');
  //     }
  //   }
  // },
  // Función desactivada - modo empresarial sin auto-actualizaciones
  // async syncUpdatePrompt() {
  //   try {
  //     if (state.updateInfo) {
  //       await this.ensureUpdatePrompt(state.updateInfo);
  //     } else {
  //       await this.clearUpdatePrompt();
  //     }
  //   } catch (err) {
  //     state.logger?.error({ err }, 'Error al sincronizar el mensaje de actualización');
  //   }
  // },
  // Función _fetchRollbackPromptMessage comentada - modo empresarial sin actualizaciones
  // async _fetchRollbackPromptMessage() {
  //   const ref = state.settings.RollbackPromptMessage;
  //   if (!ref?.messageId) {
  //     return null;
  //   }
  //   const channelId = ref.channelId || state.settings.ControlChannelID;
  //   try {
  //     const channel = await this.getChannel(channelId);
  //     if (!channel) {
  //       state.settings.RollbackPromptMessage = null;
  //       return null;
  //     }
  //     const message = await channel.messages.fetch(ref.messageId);
  //     return message;
  //   } catch (err) {
  //     state.logger?.debug?.({ err }, 'No se pudo obtener el mensaje de reversión almacenado');
  //     state.settings.RollbackPromptMessage = null;
  //     return null;
  //   }
  // },
  // Función desactivada - modo empresarial sin auto-actualizaciones
  // async ensureRollbackPrompt() {
  //   if (updater.isNode) {
  //     await this.clearRollbackPrompt();
  //     return;
  //   }
  //   const hasBackup = await updater.hasBackup();
  //   if (!hasBackup) {
  //     await this.clearRollbackPrompt();
  //     return;
  //   }
  //   const content = 'Un backup de la version anterior está disponible. Use el botón debajo para revertir si experimenta problemas.';
  //   const components = [
  //     new MessageActionRow().addComponents(
  //       new MessageButton()
  //         .setCustomId(ROLLBACK_BUTTON_ID)
  //         .setLabel('Revertir')
  //         .setStyle('DANGER'),
  //     ),
  //   ];
  //   let message = await this._fetchRollbackPromptMessage();
  //   if (message) {
  //     await message.edit({ content, components });
  //     return;
  //   }
  //   const channel = await this.getControlChannel();
  //   if (!channel) {
  //     return;
  //   }
  //   message = await channel.send({ content, components });
  //   state.settings.RollbackPromptMessage = {
  //     channelId: channel.id,
  //     messageId: message.id,
  //   };
  //   try {
  //     await storage.save();
  //   } catch (err) {
  //     state.logger?.warn({ err }, 'Error al persistir los metadatos del mensaje de reversión');
  //   }
  // },
  // Función clearRollbackPrompt comentada - modo empresarial sin actualizaciones
  // async clearRollbackPrompt() {
  //   const ref = state.settings.RollbackPromptMessage;
  //   const hadStoredMessage = Boolean(ref);
  //   if (ref?.messageId) {
  //     const message = await this._fetchRollbackPromptMessage();
  //     await message?.delete().catch(() => {});
  //   }
  //   state.settings.RollbackPromptMessage = null;
  //   if (hadStoredMessage) {
  //     try {
  //       await storage.save();
  //     } catch (err) {
  //       state.logger?.warn({ err }, 'No se pudo persistir los metadatos del mensaje de reversión');
  //     }
  //   }
  // },
  // Función desactivada - modo empresarial sin auto-actualizaciones
  // async syncRollbackPrompt() {
  //   try {
  //     if (updater.isNode) {
  //       await this.clearRollbackPrompt();
  //       return;
  //     }
  //     const hasBackup = await updater.hasBackup();
  //     if (hasBackup) {
  //       await this.ensureRollbackPrompt();
  //     } else {
  //       await this.clearRollbackPrompt();
  //     }
  //   } catch (err) {
  //     state.logger?.warn({ err }, 'Error al sincronizar el mensaje de reversión');
  //   }
  // },
  async findAvailableName(dir, fileName) {
    const safeName = sanitizePathSegment(fileName, 'file');
    const parsed = path.parse(safeName);
    const baseName = parsed.name || 'file';
    const ext = parsed.ext || '';

    let counter = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const suffix = counter === 0 ? '' : `-${counter}`;
      const candidate = `${baseName}${suffix}${ext}`;
      const absPath = path.resolve(dir, candidate);
      try {
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.stat(absPath);
        counter += 1;
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return [absPath, candidate];
        }
        throw err;
      }
    }
  },
  async pruneDownloadsDir(ignorePath) {
    const limitGB = Number(state.settings.DownloadDirLimitGB) || 0;
    const maxAgeDays = Number(state.settings.DownloadDirMaxAgeDays) || 0;
    const minFreeGB = Number(state.settings.DownloadDirMinFreeGB) || 0;

    const limitBytes = limitGB > 0 ? limitGB * 1024 * 1024 * 1024 : null;
    const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : null;
    const minFreeBytes = minFreeGB > 0 ? minFreeGB * 1024 * 1024 * 1024 : null;

    if (!limitBytes && !maxAgeMs && !minFreeBytes) return;

    const resolvedDownloadDir = path.resolve(state.settings.DownloadDir);
    const resolvedIgnorePath = ignorePath ? path.resolve(ignorePath) : null;
    let entries;
    try {
      entries = await fs.promises.readdir(state.settings.DownloadDir);
    } catch {
      return;
    }
    const files = await Promise.all(
      entries.map(async (name) => {
        const filePath = path.resolve(resolvedDownloadDir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) return null;
          return { filePath, mtime: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      }),
    );
    let validFiles = files.filter(Boolean).sort((a, b) => a.mtime - b.mtime);

    const deleteFile = async (file) => {
      if (!file?.filePath) return false;
      if (resolvedIgnorePath && file.filePath === resolvedIgnorePath) return false;
      try {
        await fs.promises.unlink(file.filePath);
        return true;
      } catch {
        return false;
      }
    };

    if (maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      const remaining = [];
      for (const file of validFiles) {
        if (file.mtime >= cutoff) {
          remaining.push(file);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const deleted = await deleteFile(file);
        if (!deleted) {
          remaining.push(file);
        }
      }
      validFiles = remaining;
    }

    if (limitBytes) {
      let total = validFiles.reduce((sum, f) => sum + f.size, 0);
      const remaining = [];
      for (const file of validFiles) {
        if (total <= limitBytes) {
          remaining.push(file);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const deleted = await deleteFile(file);
        if (deleted) {
          total -= file.size;
        } else {
          remaining.push(file);
        }
      }
      validFiles = remaining;
    }

    if (minFreeBytes) {
      let freeBytes = null;
      try {
        const statfs = await fs.promises.statfs(resolvedDownloadDir);
        const bavail = Number(statfs?.bavail);
        const bsize = Number(statfs?.bsize);
        if (Number.isFinite(bavail) && Number.isFinite(bsize)) {
          freeBytes = bavail * bsize;
        }
      } catch {
        freeBytes = null;
      }

      if (freeBytes != null && freeBytes < minFreeBytes) {
        const remaining = [];
        for (const file of validFiles) {
          if (freeBytes >= minFreeBytes) {
            remaining.push(file);
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const deleted = await deleteFile(file);
          if (deleted) {
            freeBytes += file.size;
          } else {
            remaining.push(file);
          }
        }
        validFiles = remaining;
      }
    }
  },
  async downloadLargeFile(file) {
    await fs.promises.mkdir(state.settings.DownloadDir, { recursive: true, mode: 0o700 });
    const [absPath, fileName] = await this.findAvailableName(state.settings.DownloadDir, file.name);
    const writeFromDownloadCtx = async () => {
      const stream = await downloadContentFromMessage(
        file.downloadCtx.message[file.msgType],
        file.msgType.replace('Message', ''),
        { logger: state.logger, reuploadRequest: state.waClient.updateMediaMessage },
      );
      await pipeline(stream, fs.createWriteStream(absPath, { mode: 0o600 }));
    };

    try {
      if (typeof file.attachment?.pipe === 'function') {
        await pipeline(file.attachment, fs.createWriteStream(absPath, { mode: 0o600 }));
      } else if (file.downloadCtx) {
        await writeFromDownloadCtx();
      } else {
        await fs.promises.writeFile(absPath, file.attachment, { mode: 0o600 });
      }
    } catch (err) {
      // Retry once for transient network errors when we can recreate the stream.
      const canRetry = !!file.downloadCtx;
      if (canRetry) {
        state.logger?.warn({ err, file: file.name }, 'Reintentando descarga de medio de WhatsApp después de fallo');
        try {
          await writeFromDownloadCtx();
        } catch (retryErr) {
          state.logger?.error({ err: retryErr, file: file.name }, 'Falló la descarga de medio de WhatsApp después de reintentar');
          await fs.promises.rm(absPath, { force: true }).catch(() => { });
          return '\nAtención WA2DC: Falló la descarga del archivo adjunto de WhatsApp. Por favor verifique WhatsApp o intente nuevamente.';
        }
      } else {
        state.logger?.error({ err, file: file.name }, 'Falló la descarga de medio de WhatsApp');
        await fs.promises.rm(absPath, { force: true }).catch(() => { });
        return '\nAtención WA2DC: Falló la descarga del archivo adjunto de WhatsApp. Por favor verifique WhatsApp o intente nuevamente.';
      }
    }
    await this.pruneDownloadsDir(absPath);
    let url;
    if (state.settings.LocalDownloadServer) {
      ensureDownloadServer();
      const server = ensureDownloadServer.server;
      if (!server) {
        url = pathToFileURL(absPath).href;
      } else {
        const token = buildDownloadToken(fileName);
        const configuredHost = typeof state.settings.LocalDownloadServerHost === 'string'
          ? state.settings.LocalDownloadServerHost.trim()
          : '';
        const publicHost = (configuredHost && !['0.0.0.0', '::'].includes(configuredHost))
          ? configuredHost
          : 'localhost';
        const hostForUrl = publicHost.includes(':') && !publicHost.startsWith('[')
          ? `[${publicHost}]`
          : publicHost;
        const address = server.listening ? server.address() : null;
        const port = (state.settings.LocalDownloadServerPort === 0 && address && typeof address === 'object')
          ? address.port
          : state.settings.LocalDownloadServerPort;
        const protocol = ensureDownloadServer.protocol || 'http';
        url = `${protocol}://${hostForUrl}:${port}/${token}/${encodeURIComponent(fileName)}`;
      }
    } else {
      url = pathToFileURL(absPath).href;
    }
    return this.formatDownloadMessage(
      absPath,
      path.resolve(state.settings.DownloadDir),
      fileName,
      url,
    );
  },
  formatDownloadMessage(absPath, resolvedDownloadDir, fileName, url) {
    return state.settings.LocalDownloadMessage
      .replaceAll("{abs}", absPath)
      .replaceAll("{resolvedDownloadDir}", resolvedDownloadDir)
      .replaceAll("{downloadDir}", state.settings.DownloadDir)
      .replaceAll("{fileName}", fileName)
      .replaceAll("{url}", url)
  }
};

const whatsapp = {
  jidToPhone(jid = '') {
    if (!jid) return '';
    return String(jid).split(':')[0].split('@')[0];
  },
  ensurePrivacySalt() {
    return ensurePrivacySaltKey();
  },
  isPhoneLike(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (/[a-z]/i.test(trimmed)) return false;
    const digits = trimmed.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
  },
  privacyTagForJid(jid) {
    const key = ensurePrivacySaltKey();
    const normalized = this.formatJid(jid) || String(jid || '');
    if (!normalized) return 'desconocido';
    const digest = crypto.createHmac('sha256', key)
      .update(normalized, 'utf8')
      .digest('base64url');
    return digest.slice(0, 10);
  },
  anonymousName(jid) {
    const tag = this.privacyTagForJid(jid);
    return `Usuario WA ${tag}`;
  },
  anonymousChannelName(jid) {
    const normalized = this.formatJid(jid) || String(jid || '');
    const tag = this.privacyTagForJid(normalized);
    if (normalized === 'status@broadcast') return 'estado';
    if (typeof normalized === 'string' && normalized.endsWith('@g.us')) return `grupo-wa-${tag}`;
    return `usuario-wa-${tag}`;
  },
  formatJidForDisplay(jid) {
    const formatted = this.formatJid(jid) || String(jid || '');
    if (!formatted) return '';
    if (!state.settings?.HidePhoneNumbers) return formatted;
    if (!this.isPhoneJid(formatted)) return formatted;
    return `pn:redacted:${this.privacyTagForJid(formatted)}`;
  },
  formatJid(jid) {
    if (!jid) return null;
    const [userPart, serverPart] = String(jid).split('@');
    if (!serverPart) return String(jid);
    const cleanUser = userPart.split(':')[0];
    const normalizedUser = (() => {
      const server = String(serverPart).trim();
      if (server !== 's.whatsapp.net' && server !== 'lid') return cleanUser;
      const digitsOnly = String(cleanUser).replace(/\D/g, '');
      return digitsOnly || cleanUser;
    })();
    return `${normalizedUser}@${serverPart}`;
  },
  isPhoneJid(jid = '') {
    return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
  },
  isLidJid(jid = '') {
    return typeof jid === 'string' && jid.endsWith('@lid');
  },
  normalizeMentionLinks() {
    const links = state.settings?.WhatsAppDiscordMentionLinks;
    if (!links || typeof links !== 'object' || Array.isArray(links)) return false;

    let changed = false;
    for (const [jidRaw, discordId] of Object.entries({ ...links })) {
      const normalized = this.formatJid(jidRaw);
      if (!normalized || normalized === jidRaw) continue;

      if (!Object.prototype.hasOwnProperty.call(links, normalized)) {
        links[normalized] = discordId;
      } else if (links[normalized] !== discordId) {
        state.logger?.warn?.(
          { from: jidRaw, to: normalized },
          'Conflicto de enlaces de mención; manteniendo la entrada normalizada',
        );
      }

      delete links[jidRaw];
      changed = true;
    }
    return changed;
  },
  migrateLegacyJid(oldJid, newJid) {
    const legacy = this.formatJid(oldJid);
    const fresh = this.formatJid(newJid);
    if (!legacy || !fresh || legacy === fresh) return;
    const migrateKey = (container) => {
      if (!container || !Object.prototype.hasOwnProperty.call(container, legacy)) return;
      if (!Object.prototype.hasOwnProperty.call(container, fresh)) {
        container[fresh] = container[legacy];
      }
      delete container[legacy];
    };
    migrateKey(state.chats);
    migrateKey(state.contacts);
    migrateKey(state.goccRuns);
    migrateKey(state.settings?.WhatsAppDiscordMentionLinks);
    const whitelist = state.settings?.Whitelist;
    if (Array.isArray(whitelist) && whitelist.length) {
      const normalized = whitelist.map((jid) => {
        const formatted = this.formatJid(jid);
        return formatted === legacy ? fresh : formatted;
      });
      state.settings.Whitelist = [...new Set(normalized.filter(Boolean))];
    }
  },
  resolveKnownJid(...candidates) {
    const flat = candidates.flat().filter(Boolean);
    for (const jid of flat) {
      if (state.chats[jid]) return jid;
    }
    for (const jid of flat) {
      if (state.contacts[jid]) return jid;
    }
    return flat.find(Boolean) || null;
  },
  async generateLinkPreview(text, { uploadImage, logger } = {}) {
    return discord.generateLinkPreview(text, { uploadImage, logger });
  },
  getChatJidCandidates(rawMsg = {}) {
    const { key = {} } = rawMsg;
    const remoteJid = this.formatJid(
      key.remoteJid
      || rawMsg.chatId
      || rawMsg.attrs?.from
      || rawMsg.from
      || rawMsg.jid,
    );
    const remoteJidAlt = this.formatJid(key.remoteJidAlt || rawMsg.remoteJidAlt);
    const candidates = [];
    if (remoteJid) candidates.push(remoteJid);
    if (remoteJidAlt && !candidates.includes(remoteJidAlt)) candidates.push(remoteJidAlt);
    return candidates;
  },
  isStatusBroadcast(rawMsg = {}) {
    const [candidatePrimary] = this.getChatJidCandidates(rawMsg);
    return candidatePrimary === 'status@broadcast';
  },
  isMe(myJID, jid) {
    return jid.startsWith(this.jidToPhone(myJID)) && !jid.endsWith('@g.us');
  },
  jidToName(jid, pushName) {
    const formatted = this.formatJid(jid) || String(jid || '');
    const myJid = state.waClient?.user?.id;
    if (myJid && formatted && this.isMe(myJid, formatted)) { return 'Tú'; }
    const contactName = (formatted && (state.waClient?.contacts?.[formatted] ?? state.contacts?.[formatted])) || null;
    const hidePhones = Boolean(state.settings?.HidePhoneNumbers);
    const candidates = [contactName, pushName];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (hidePhones && this.isPhoneLike(trimmed)) continue;
      return trimmed;
    }
    if (!hidePhones) {
      const fallback = this.jidToPhone(formatted);
      return fallback ? fallback : 'Desconocido';
    }
    return formatted ? this.anonymousName(formatted) : 'Desconocido';
  },
  toJid(name) {
    if (!name) return null;
    const trimmed = String(name).trim();
    const isPhoneLike = /^\+?[\d\s().-]+$/.test(trimmed);
    if (isPhoneLike) {
      const digits = trimmed.replace(/\D/g, '');
      if (digits) return this.formatJid(`${digits}@s.whatsapp.net`);
    }
    // eslint-disable-next-line no-restricted-globals
    if (!isNaN(trimmed)) { return this.formatJid(`${trimmed}@s.whatsapp.net`); }
    if (trimmed.includes('@')) {
      return this.formatJid(trimmed);
    }
    if (state.settings?.HidePhoneNumbers) {
      const match = trimmed.match(/^wa-(?:user|group)-([a-z0-9_-]{6,})$/i)
        || trimmed.match(/^wa\s+(?:user|group)\s+([a-z0-9_-]{6,})$/i);
      const tag = match?.[1];
      if (tag) {
        const jidCandidates = new Set([
          ...Object.keys(state.waClient?.contacts || {}),
          ...Object.keys(state.contacts || {}),
          ...Object.keys(state.chats || {}),
        ]);
        for (const jidCandidate of jidCandidates) {
          if (!jidCandidate) continue;
          if (this.privacyTagForJid(jidCandidate) === tag) {
            return this.formatJid(jidCandidate);
          }
        }
      }
    }
    const normalized = trimmed.toLowerCase();
    const contactStore = state.waClient?.contacts || state.contacts || {};
    const matches = Object.keys(contactStore)
      .filter((key) => contactStore[key]
        && contactStore[key].toLowerCase().trim() === normalized);
    const preferred = matches.find((jid) => this.isPhoneJid(jid)) || matches[0];
    return this.formatJid(preferred);
  },
  jidToChannelName(jid, pushName) {
    const hidePhones = Boolean(state.settings?.HidePhoneNumbers);
    if (!hidePhones) return this.jidToName(jid, pushName);
    const formatted = this.formatJid(jid) || String(jid || '');
    const name = this.jidToName(formatted, pushName);
    if (!name || name === 'Desconocido') return this.anonymousChannelName(formatted);
    if (formatted && name === this.anonymousName(formatted)) return this.anonymousChannelName(formatted);
    if (this.isPhoneLike(name)) return this.anonymousChannelName(formatted);
    return name;
  },
  contacts() {
    return Object.values(state.waClient?.contacts || {});
  },
  convertDiscordFormatting(text = '') {
    if (!text) return text;
    let converted = text;
    converted = converted.replace(/```(\w+)\n/g, '```\n');
    converted = converted.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');
    converted = converted.replace(/\*\*\*(.+?)\*\*\*/g, '_*$1*_');
    converted = converted.replace(/\*\*(.+?)\*\*/g, '*$1*');
    converted = converted.replace(/~~(.+?)~~/g, '~$1~');
    return converted;
  },
  getMentionedJids(text) {
    const mentions = new Set();
    if (!text) return [];

    const cleaned = text.replace(/<@!?\d+>|<@&\d+>/g, '');
    const lower = cleaned.toLowerCase();
    const contactStore = state.waClient?.contacts || state.contacts || {};

    for (const [jid, name] of Object.entries(contactStore)) {
      if (!name) continue;
      if (lower.includes(`@${String(name).toLowerCase()}`)) {
        const formatted = this.formatJid(jid);
        if (formatted) mentions.add(formatted);
      }
    }

    // Support phone-number tokens like "@14155550123" (or "@+14155550123").
    const phoneMentionRegex = /@(\+?\d{7,15})(?=\W|$)/g;
    let match;
    while ((match = phoneMentionRegex.exec(cleaned)) !== null) {
      const digits = String(match[1] || '').replace(/\D/g, '');
      if (!digits) continue;
      const jid = this.formatJid(`${digits}@s.whatsapp.net`);
      if (jid) mentions.add(jid);
    }

    return [...mentions];
  },
  getLinkedJidsForDiscordUserId(discordUserId) {
    const links = state.settings?.WhatsAppDiscordMentionLinks;
    if (!links || typeof links !== 'object' || Array.isArray(links)) return [];
    const normalizedId = typeof discordUserId === 'string' ? discordUserId.trim() : String(discordUserId || '').trim();
    if (!/^\d+$/.test(normalizedId)) return [];

    const results = new Set();
    for (const [jidRaw, discordIdRaw] of Object.entries(links)) {
      const storedId = typeof discordIdRaw === 'string' ? discordIdRaw.trim() : '';
      if (storedId !== normalizedId) continue;
      const formatted = this.formatJid(jidRaw);
      if (formatted) results.add(formatted);
    }
    return [...results];
  },
  async preferMentionJidForChat(mentionJid) {
    const formatted = this.formatJid(mentionJid);
    if (!formatted) return null;

    const store = state.waClient?.signalRepository?.lidMapping;

    // Outgoing mentions: prefer PN JIDs where possible (most compatible).
    if (this.isPhoneJid(formatted)) return formatted;
    if (this.isLidJid(formatted) && store && typeof store.getPNForLID === 'function') {
      try {
        const pn = this.formatJid(await store.getPNForLID(formatted));
        if (pn) return pn;
      } catch (err) {
        state.logger?.debug?.({ err }, 'No se pudo resolver el JID PN para la mención');
      }
    }
    return formatted;
  },
  async applyDiscordMentionLinks(text, mentionDescriptors = [], { appendTrailing = false, chatJid = null } = {}) {
    if (!text) return { text, mentionJids: [] };
    if (!Array.isArray(mentionDescriptors) || mentionDescriptors.length === 0) {
      return { text, mentionJids: [] };
    }

    const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const buildMentionRegex = (token) => new RegExp(
      `@${escapeRegex(token)}(?=$|\\s|[\\p{P}\\p{S}])`,
      'giu',
    );

    const mentionJids = new Set();
    let nextText = text;
    const appended = new Set();

    for (const descriptor of mentionDescriptors) {
      const discordUserId = descriptor?.discordUserId;
      const displayTokens = Array.isArray(descriptor?.displayTokens) ? descriptor.displayTokens : [];
      const rawTokens = Array.isArray(descriptor?.rawTokens) ? descriptor.rawTokens : [];
      if (!discordUserId) continue;

      const linked = this.getLinkedJidsForDiscordUserId(discordUserId);
      if (!linked.length) continue;

      const preferred = linked.find((jid) => this.isPhoneJid(jid)) || linked[0];

      let mentionJid = await this.preferMentionJidForChat(preferred, chatJid);
      if (!mentionJid) continue;

      const replacementToken = this.isPhoneJid(mentionJid)
        ? `@${this.jidToPhone(mentionJid)}`
        : `@${this.jidToName(mentionJid)}`;

      let replaced = false;
      const candidates = [...new Set(displayTokens.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean))];

      const rawCandidates = [...new Set(rawTokens.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean))];
      for (const token of rawCandidates) {
        const regex = new RegExp(escapeRegex(token), 'g');
        const updated = nextText.replace(regex, replacementToken);
        if (updated === nextText) continue;
        nextText = updated;
        replaced = true;
      }

      for (const token of candidates) {
        const regex = buildMentionRegex(token);
        const updated = nextText.replace(regex, replacementToken);
        if (updated === nextText) continue;
        nextText = updated;
        replaced = true;
      }

      if (replaced) {
        mentionJids.add(mentionJid);
      } else if (appendTrailing && !appended.has(mentionJid)) {
        nextText = nextText ? `${nextText} ${replacementToken}` : replacementToken;
        appended.add(mentionJid);
        mentionJids.add(mentionJid);
      }
    }

    return { text: nextText, mentionJids: [...mentionJids] };
  },
  async sendQR(qrString) {
    await (await discord.getControlChannel())
      .send({ files: [new MessageAttachment(await QRCode.toBuffer(qrString), 'qrcode.png')] });
  },
  async hydrateJidPair(primary, alternate) {
    let preferred = this.formatJid(primary);
    let fallback = this.formatJid(alternate);
    if (preferred && fallback) {
      const phone = this.isPhoneJid(preferred) ? preferred : (this.isPhoneJid(fallback) ? fallback : null);
      const lid = this.isLidJid(preferred) ? preferred : (this.isLidJid(fallback) ? fallback : null);
      if (phone && lid) {
        this.migrateLegacyJid(lid, phone);
        return [phone, lid];
      }
      return [preferred, fallback];
    }

    const store = state.waClient?.signalRepository?.lidMapping;
    if (!store || !preferred) {
      return [preferred, fallback];
    }

    try {
      if (!fallback && this.isLidJid(preferred) && typeof store.getPNForLID === 'function') {
        const pnJid = this.formatJid(await store.getPNForLID(preferred));
        if (pnJid) {
          fallback = preferred;
          preferred = pnJid;
          this.migrateLegacyJid(fallback, preferred);
        }
      } else if (!fallback && this.isPhoneJid(preferred) && typeof store.getLIDForPN === 'function') {
        const lidJid = this.formatJid(await store.getLIDForPN(preferred));
        if (lidJid) {
          fallback = lidJid;
          this.migrateLegacyJid(lidJid, preferred);
        }
      }
    } catch (err) {
      state.logger?.warn({ err }, 'No se pudo reconstruir el identificador JID a partir del registro de correspondencias LID.');
    }

    return [preferred, fallback];
  },
  async getChannelJid(rawMsg) {
    if (this.isStatusBroadcast(rawMsg)) {
      return 'status@broadcast';
    }
    const [candidatePrimary, candidateAlternate] = this.getChatJidCandidates(rawMsg);
    const [primary, alternate] = await this.hydrateJidPair(candidatePrimary, candidateAlternate);
    return this.resolveKnownJid(primary, alternate);
  },
  async getSenderJid(rawMsg, fromMe) {
    if (fromMe) { return this.formatJid(state.waClient.user.id); }
    const { key = {} } = rawMsg || {};
    const participant = this.formatJid(key.participant || rawMsg?.participant);
    const participantAlt = this.formatJid(key.participantAlt || rawMsg?.participantAlt || key.remoteJidAlt);
    const [primary, alternate] = await this.hydrateJidPair(participant, participantAlt);
    const resolved = this.resolveKnownJid(primary, alternate);
    if (resolved) return resolved;
    const [chatCandidatePrimary, chatCandidateAlternate] = this.getChatJidCandidates(rawMsg);
    const [chatPrimary, chatAlternate] = await this.hydrateJidPair(chatCandidatePrimary, chatCandidateAlternate);
    return this.resolveKnownJid(chatPrimary, chatAlternate) || chatPrimary || chatAlternate;
  },
  async getSenderName(rawMsg) {
    return this.jidToName(await this.getSenderJid(rawMsg, rawMsg.key.fromMe), rawMsg.pushName);
  },
  isGroup(rawMsg) {
    if (this.isStatusBroadcast(rawMsg)) return false;
    return rawMsg?.key?.participant != null;
  },
  isForwarded(msg) {
    return msg?.contextInfo?.isForwarded;
  },
  isQuoted(msg) {
    return msg?.contextInfo?.quotedMessage;
  },
  async getQuote(rawMsg) {
    const msgType = this.getMessageType(rawMsg);
    const [, msg] = this.getMessage(rawMsg, msgType);

    if (!msgType || !msg) return null;

    const context = msg.contextInfo;
    const qMsg = context?.quotedMessage;
    if (!qMsg) return null;

    const qMsgType = this.getMessageType({ message: qMsg });

    const [nMsgType, message] = this.getMessage({ message: qMsg }, qMsgType);
    const { content } = await this.getContent(message, nMsgType, qMsgType, { mentionTarget: 'name' });

    const quoteParticipant = this.formatJid(context?.participant);
    const quoteParticipantAlt = this.formatJid(context?.participantAlt);
    const quoteNameFromParticipant = async () => {
      const [primary, alternate] = await this.hydrateJidPair(quoteParticipant, quoteParticipantAlt);
      const resolved = this.resolveKnownJid(primary, alternate, quoteParticipant, quoteParticipantAlt)
        || primary
        || alternate
        || quoteParticipant
        || quoteParticipantAlt
        || '';
      return this.jidToName(resolved);
    };

    const quoteNameFromStore = async () => {
      if (!context?.stanzaId) return null;
      const rawRemote = this.formatJid(rawMsg?.key?.remoteJid);
      const rawRemoteAlt = this.formatJid(rawMsg?.key?.remoteJidAlt || rawMsg?.key?.participantAlt || rawMsg?.remoteJidAlt);
      const [primary, alternate] = await this.hydrateJidPair(rawRemote, rawRemoteAlt);
      const candidates = [...new Set([rawRemote, rawRemoteAlt, primary, alternate].filter(Boolean))];
      for (const remoteJid of candidates) {
        const stored = messageStore.get({ remoteJid, id: context.stanzaId });
        if (stored) {
          return this.getSenderName(stored);
        }
      }
      return null;
    };

    const quoteName = await quoteNameFromStore() || await quoteNameFromParticipant();
    let file = null;
    if (qMsgType && context?.stanzaId) {
      const quoteDownloadParticipant = this.formatJid(context?.participant || context?.participantAlt);
      if (context?.participant && context?.participantAlt) {
        this.migrateLegacyJid(context.participantAlt, context.participant);
      }
      const downloadCtx = {
        key: {
          remoteJid: (await this.getChannelJid(rawMsg)) || rawMsg.key.remoteJid,
          id: context.stanzaId,
          fromMe: rawMsg.key.fromMe,
          participant: quoteDownloadParticipant,
        },
        message: qMsg,
      };
      file = await this.getFile(downloadCtx, qMsgType);
    }

    const quote = {
      name: quoteName,
      content,
      file,
    };

    if (context?.stanzaId) {
      quote.id = context.stanzaId;
    }

    return quote;
  },
  getMessage(rawMsg, msgType) {
    if (msgType === 'documentWithCaptionMessage') {
      return ["documentMessage", rawMsg.message[msgType].message.documentMessage];
    }
    else if (msgType === 'viewOnceMessageV2') {
      const nMsgType = this.getMessageType(rawMsg.message[msgType]);
      return [nMsgType, rawMsg.message[msgType].message[nMsgType]];
    }
    else if (msgType === 'editedMessage') {
      const nMsgType = this.getMessageType({ message: rawMsg.message[msgType].message.protocolMessage.editedMessage });
      return [nMsgType, rawMsg.message[msgType].message.protocolMessage.editedMessage[nMsgType]];
    }
    return [msgType, rawMsg.message[msgType]];
  },
  getFilename(msg, msgType) {
    if (msgType === 'audioMessage') {
      return 'audio.ogg';
    }
    else if ('documentMessage' === msgType) {
      return msg.fileName;
    }
    const ext = msg.mimetype?.split('/')?.[1] || 'bin';
    return `${msgType}.${ext}`;
  },
  async getFile(rawMsg, msgType) {
    const [nMsgType, msg] = this.getMessage(rawMsg, msgType);
    if (msg.fileLength == null) return;
    const fileLength = typeof msg.fileLength === 'object'
      ? msg.fileLength.low ?? msg.fileLength.toNumber()
      : msg.fileLength;
    const largeFile = fileLength > state.settings.DiscordFileSizeLimit;
    if (largeFile && !state.settings.LocalDownloads) return -1;
    try {
      if (largeFile && state.settings.LocalDownloads) {
        return {
          name: this.getFilename(msg, nMsgType),
          downloadCtx: rawMsg,
          msgType: nMsgType,
          largeFile: true,
        };
      }
      return {
        name: this.getFilename(msg, nMsgType),
        // Download media as a stream to avoid buffering entire files in memory
        attachment: await downloadMediaMessage(rawMsg, 'stream', {}, {
          logger: state.logger,
          reuploadRequest: state.waClient.updateMediaMessage,
        }),
        largeFile,
        downloadCtx: rawMsg,
        msgType: nMsgType,
      };
    } catch (err) {
      if (err?.message?.includes('Unrecognised filter type') || err?.message?.includes('Tipo de filtro no reconocido.')) {
        // Jimp sometimes throws this error when a PNG file is corrupted or malformed.
        // Avoid spamming the log with a stack trace for such cases.
        state.logger?.warn('Omitiendo envío de archivo adjunto debido a un archivo PNG inválido');
      } else {
        state.logger?.error(err);
      }
      return null;
    }
  },
  inWhitelist(rawMsg) {
    const whitelist = state.settings.Whitelist || [];
    if (!whitelist.length) return true;
    const normalized = whitelist.map((jid) => this.formatJid(jid)).filter(Boolean);
    const candidates = this.getChatJidCandidates(rawMsg);
    return candidates.some((jid) => normalized.includes(jid));
  },
  getTimestamp(rawMsg) {
    if (rawMsg?.messageTimestamp) return rawMsg.messageTimestamp;
    if (rawMsg?.reaction?.senderTimestampMs) return Math.round(rawMsg.reaction.senderTimestampMs / 1000);
    if (rawMsg?.date) return Math.round(rawMsg.date.getTime() / 1000);
    return 0;
  },
  sentAfterStart(rawMsg) {
    const ts = this.getTimestamp(rawMsg);
    const id = this.getId(rawMsg);
    return ts > state.startTime || id == null || !Object.prototype.hasOwnProperty.call(state.lastMessages, id);
  },
  getMessageType(rawMsg) {
    return [
      'conversation',
      'extendedTextMessage',
      'imageMessage',
      'videoMessage',
      'audioMessage',
      'documentMessage',
      'documentWithCaptionMessage',
      'viewOnceMessageV2',
      'stickerMessage',
      'editedMessage',
      'pollCreationMessage',
      'pollCreationMessageV2',
      'pollCreationMessageV3',
      'pollCreationMessageV4',
      'pollUpdateMessage',
      'pollResultSnapshotMessage',
      'pinInChatMessage',
    ].find((el) => Object.hasOwn(rawMsg.message || {}, el));
  },
  // Función de fotos de perfil comentada - modo empresarial sin acceso a fotos de perfil
  // _profilePicsCache: {},
  // async getProfilePic(rawMsg) {
  //   const jid = await this.getSenderJid(rawMsg, rawMsg?.key?.fromMe);
  //   if (this._profilePicsCache[jid] === undefined) {
  //     this._profilePicsCache[jid] = await state.waClient.profilePictureUrl(jid, 'preview').catch(() => null);
  //   }
  //   return this._profilePicsCache[jid];
  // },
  getId(rawMsg) {
    return rawMsg?.message?.editedMessage?.message?.protocolMessage?.key?.id
      || rawMsg?.key?.id
      || rawMsg?.id;
  },
  async getContent(msg, nMsgType, msgType, { mentionTarget = 'name' } = {}) {
    let content = '';
    const discordMentions = new Set();
    if (msgType === 'viewOnceMessageV2') {
      content += 'Mensaje de vista única:\n';
    }
    if (msg == null) {
      return { content, discordMentions: [] };
    }
    switch (nMsgType) {
      case 'conversation':
        content += msg;
        break;
      case 'extendedTextMessage':
        content += msg.text;
        break;
      case 'imageMessage':
      case 'videoMessage':
      case 'audioMessage':
      case 'documentMessage':
      case 'documentWithCaptionMessage':
      case 'stickerMessage':
        content += msg.caption || '';
        break;
      case 'pollCreationMessage':
      case 'pollCreationMessageV2':
      case 'pollCreationMessageV3':
      case 'pollCreationMessageV4': {
        const options = Array.isArray(msg.options) ? msg.options : [];
        const optionText = options.map((opt, idx) => `${idx + 1}. ${opt.optionName || 'Opción'}`).join('\n');
        const selectable = msg.selectableOptionsCount || msg.selectableCount;
        content += `Encuesta: ${msg.name || 'Encuesta sin título'}`;
        if (selectable && selectable > 1) {
          content += ` (seleccionar hasta ${selectable})`;
        }
        if (optionText) {
          content += `\n${optionText}`;
        }
        break;
      }
      case 'pinInChatMessage':
        content += 'Mensaje fijado';
        break;
    }
    const contextInfo = typeof msg === 'object' && msg !== null ? msg.contextInfo : undefined;
    const mentions = contextInfo?.mentionedJid || [];
    const links = state.settings?.WhatsAppDiscordMentionLinks;
    const hasLinks = links && typeof links === 'object';

    const normalizeDiscordUserId = (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return /^\d+$/.test(trimmed) ? trimmed : null;
    };

    const resolveLinkedDiscordUserId = async (jid) => {
      if (!hasLinks) return null;
      const formatted = this.formatJid(jid);
      if (!formatted) return null;

      const normalizeNameForMatch = (value) => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed
          .normalize('NFKC')
          .toLowerCase()
          .replace(/\s+/g, ' ');
      };

      const getStoredContactName = (candidateJid) => {
        const normalized = this.formatJid(candidateJid);
        if (!normalized) return null;
        const stored = state.contacts?.[normalized] || state.waClient?.contacts?.[normalized];
        const normalizedName = normalizeNameForMatch(stored);
        if (!normalizedName) return null;
        if (normalizedName === 'desconocido' || normalizedName === 'tú') return null;
        if (/^\d+$/.test(normalizedName)) return null;
        return normalizedName;
      };

      const lookup = (candidate) => {
        if (!candidate) return null;
        return normalizeDiscordUserId(links[candidate]);
      };

      const lookupCandidates = (candidate) => {
        const normalized = this.formatJid(candidate);
        if (!normalized) return [];
        const [userPart, serverPart] = normalized.split('@');
        const candidates = [normalized];
        if ((serverPart === 's.whatsapp.net' || serverPart === 'lid') && /^\d+$/.test(userPart)) {
          candidates.push(`+${userPart}@${serverPart}`);
        }
        return [...new Set(candidates)];
      };

      const tryLookup = (candidate) => {
        for (const key of lookupCandidates(candidate)) {
          const found = lookup(key);
          if (found) return { discordUserId: found, keys: lookupCandidates(candidate) };
        }
        return null;
      };

      const direct = tryLookup(formatted);
      if (direct) return { discordUserId: direct.discordUserId, jids: [formatted, ...direct.keys] };

      const [primary, alternate] = await this.hydrateJidPair(formatted, null);
      const resolved = this.resolveKnownJid(primary, alternate);
      const resolvedCandidate = resolved || primary || alternate;
      const found = tryLookup(resolvedCandidate) || tryLookup(primary) || tryLookup(alternate);
      const jids = [formatted, primary, alternate, resolved].filter(Boolean);
      if (found) return { discordUserId: found.discordUserId, jids: [...jids, ...found.keys] };

      // Fallback: if WhatsApp provides LID JIDs but the PN<->LID mapping store
      // can't resolve it, try matching based on the stored contact name.
      const mentionName = getStoredContactName(formatted)
        || getStoredContactName(resolvedCandidate)
        || getStoredContactName(primary)
        || getStoredContactName(alternate);
      if (!mentionName) return null;

      const matchingKeys = [];
      const candidateDiscordIds = new Set();
      for (const [linkJid, discordIdRaw] of Object.entries(links)) {
        const discordUserId = normalizeDiscordUserId(discordIdRaw);
        if (!discordUserId) continue;
        const linkName = getStoredContactName(linkJid);
        if (!linkName) continue;
        if (linkName !== mentionName) continue;
        matchingKeys.push(linkJid);
        candidateDiscordIds.add(discordUserId);
      }
      if (candidateDiscordIds.size !== 1) return null;

      return {
        discordUserId: [...candidateDiscordIds][0],
        jids: [...new Set([...jids, ...matchingKeys].filter(Boolean))],
      };
    };

    const normalizeMentionName = (value, { allowPhone = true } = {}) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed || trimmed === 'Desconocido' || trimmed === 'Tú') return null;
      if (!allowPhone && this.isPhoneLike(trimmed)) return null;
      return trimmed;
    };

    const getDiscordNameForUserId = (discordUserId) => {
      const normalized = normalizeDiscordUserId(discordUserId);
      if (!normalized) return null;
      const guildId = typeof state.settings?.GuildID === 'string' ? state.settings.GuildID.trim() : '';
      const guild = guildId ? state.dcClient?.guilds?.cache?.get(guildId) : null;
      const member = guild?.members?.cache?.get(normalized);
      const memberName = normalizeMentionName(member?.displayName, { allowPhone: false });
      if (memberName) return memberName;
      const user = member?.user || state.dcClient?.users?.cache?.get(normalized);
      return normalizeMentionName(user?.globalName, { allowPhone: false })
        || normalizeMentionName(user?.username, { allowPhone: false })
        || null;
    };

    const resolveBestMentionName = (jidCandidates, linkedDiscordUserId = null) => {
      const normalizedCandidates = [...new Set((Array.isArray(jidCandidates) ? jidCandidates : [jidCandidates])
        .map((candidate) => this.formatJid(candidate))
        .filter(Boolean))];

      if (linkedDiscordUserId) {
        const discordName = getDiscordNameForUserId(linkedDiscordUserId);
        if (discordName) return discordName;
      }

      for (const candidate of normalizedCandidates) {
        const display = normalizeMentionName(this.jidToName(candidate), { allowPhone: false });
        if (display) return display;
      }

      for (const candidate of normalizedCandidates) {
        const fallback = normalizeMentionName(this.jidToName(candidate));
        if (fallback) return fallback;
      }

      const phoneFallback = normalizedCandidates.map((candidate) => this.jidToPhone(candidate)).find(Boolean);
      return phoneFallback || 'Desconocido';
    };

    const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const buildMentionRegex = (token) => new RegExp(`@${escapeRegex(token)}(?=\\W|$)`, 'g');
    const trailingMentions = new Set();

    for (const jid of mentions) {
      const formattedMentionJid = this.formatJid(jid);
      if (!formattedMentionJid) continue;

      const linked = await resolveLinkedDiscordUserId(formattedMentionJid);
      const [primary, alternate] = await this.hydrateJidPair(formattedMentionJid, null);
      const resolved = this.resolveKnownJid(primary, alternate) || primary || alternate || formattedMentionJid;
      const tokenCandidates = [...new Set([
        formattedMentionJid,
        primary,
        alternate,
        resolved,
        ...(Array.isArray(linked?.jids) ? linked.jids : []),
      ].filter(Boolean))];

      let replacement = `@${resolveBestMentionName(
        tokenCandidates,
        mentionTarget === 'name' ? linked?.discordUserId : null,
      )}`;
      let nameToken = resolveBestMentionName(tokenCandidates);
      let shouldAppendIfNotFound = false;

      if (mentionTarget === 'discord' && linked?.discordUserId) {
        discordMentions.add(linked.discordUserId);
        replacement = `<@${linked.discordUserId}>`;
        shouldAppendIfNotFound = true;
      }

      const mentionTokens = [...new Set(tokenCandidates.map((candidate) => this.jidToPhone(candidate)).filter(Boolean))];
      const mentionTextCandidates = new Set();
      for (const token of mentionTokens) {
        if (!token) continue;
        mentionTextCandidates.add(token);
        if (/^\d+$/.test(token)) mentionTextCandidates.add(`+${token}`);
      }
      if (typeof nameToken === 'string') {
        const trimmed = nameToken.trim();
        if (trimmed && trimmed !== 'Desconocido' && trimmed !== 'Tú') mentionTextCandidates.add(trimmed);
      }

      let replaced = false;
      for (const token of mentionTextCandidates) {
        const regex = buildMentionRegex(token);
        const next = content.replace(regex, replacement);
        if (next === content) continue;
        content = next;
        replaced = true;
      }
      if (!replaced && shouldAppendIfNotFound) {
        trailingMentions.add(replacement);
      }
    }

    if (mentionTarget === 'discord' && trailingMentions.size) {
      const suffix = [...trailingMentions].join(' ');
      content = content ? `${content} ${suffix}` : suffix;
    }

    return { content, discordMentions: [...discordMentions] };
  },
  updateContacts(rawContacts) {
    const contacts = rawContacts.chats || rawContacts.contacts || rawContacts;
    for (const contact of contacts) {
      const nameCandidates = [
        { value: contact?.subject, rank: 0 },
        { value: contact?.name, rank: 0 },
        { value: contact?.verifiedName, rank: 1 },
        { value: contact?.notify, rank: 2 },
        { value: contact?.pushName, rank: 3 },
      ];
      const normalizeCandidateName = (value) => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
      };
      const selectedName = nameCandidates
        .map((entry) => ({ ...entry, normalized: normalizeCandidateName(entry.value) }))
        .find((entry) => entry.normalized);
      if (!selectedName) continue;
      const name = selectedName.normalized;
      const id = this.formatJid(contact?.id);
      const pnFromField = contact?.phoneNumber
        ? this.formatJid(`${contact.phoneNumber}@s.whatsapp.net`)
        : null;
      const pnFromId = id && this.isPhoneJid(id) ? id : null;
      const lidFromField = contact?.lid ? this.formatJid(contact.lid) : null;
      const lidFromId = id && this.isLidJid(id) ? id : null;

      const pnJid = pnFromField || pnFromId;
      const lidJid = lidFromField || lidFromId;

      const preferredId = pnJid || id || lidJid;
      const alternateId = preferredId === pnJid
        ? (lidJid && lidJid !== preferredId ? lidJid : (id && id !== preferredId ? id : null))
        : (pnJid && pnJid !== preferredId ? pnJid : (lidJid && lidJid !== preferredId ? lidJid : null));

      if (preferredId && alternateId && this.isPhoneJid(preferredId) && this.isLidJid(alternateId)) {
        this.migrateLegacyJid(alternateId, preferredId);
      }

      const targetId = preferredId || alternateId;
      if (!targetId) continue;

      const applyNameUpdate = (jid) => {
        if (!jid) return;
        const existingName = state.contacts[jid];
        const existingFallback = typeof existingName === 'string' && /^\d+$/.test(existingName.trim());
        const shouldOverwrite = !existingName || existingFallback || selectedName.rank <= 1;
        if (!shouldOverwrite) return;
        state.contacts[jid] = name;
        if (state.waClient?.contacts) {
          state.waClient.contacts[jid] = name;
        }
      };

      applyNameUpdate(targetId);
      if (alternateId && alternateId !== targetId) {
        applyNameUpdate(alternateId);
      }
    }
  },
  createDocumentContent(attachment) {
    let contentType = attachment.contentType?.split('/')?.[0] || 'application';
    contentType = ['image', 'video', 'audio'].includes(contentType) ? contentType : 'document';
    const documentContent = {};
    if (contentType === 'document') {
      documentContent['mimetype'] = attachment.contentType?.split(';')?.[0] || 'application/octet-stream';
    }
    documentContent[contentType] = { url: attachment.url };
    if (contentType === 'document') {
      documentContent.fileName = attachment.name;
    }
    if (attachment.name.toLowerCase().endsWith('.ogg')) {
      documentContent['ptt'] = true;
    }
    return documentContent;
  },
  async createQuoteMessage(message) {
    const { channelId, messageId } = message.reference || {};
    if (!channelId || !messageId) return null;

    try {
      const channel = await message.client.channels.fetch(channelId);
      const refMessage = await channel.messages.fetch(messageId);

      if (state.lastMessages[refMessage.id] == null) return null;

      return {
        key: {
          remoteJid: refMessage.webhookId && refMessage.author.username !== 'Tú'
            ? this.toJid(refMessage.author.username)
            : state.waClient.user.id,
          id: state.lastMessages[refMessage.id],
        },
        message: { conversation: this.convertDiscordFormatting(refMessage.content) },
      };
    } catch (err) {
      state.logger?.error(err);
      return null;
    }
  },

  async deleteSession() {
    const dir = './storage/baileys';
    const files = await fs.promises.readdir(dir);
    for (let file of files) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
};

const requests = {
  async fetchJson(url, options) {
    return fetch(url, options)
      .then((resp) => resp.json())
      .then((result) => ({ result }))
      .catch((error) => {
        state.logger?.error(error);
        return { error };
      });
  },

  async fetchText(url, options) {
    return fetch(url, options)
      .then((resp) => resp.text())
      .then((result) => ({ result }))
      .catch((error) => {
        state.logger?.error(error);
        return { error };
      });
  },

  async fetchBuffer(url, options) {
    return fetch(url, options)
      .then((resp) => resp.arrayBuffer())
      .then((buffer) => Buffer.from(buffer))
      .then((result) => ({ result }))
      .catch((error) => {
        state.logger?.error(error);
        return { error };
      });
  },

  async downloadFile(path, url, options) {
    const readable = await fetch(url, options).then((resp) => resp.body).catch((error) => {
      state.logger?.error(error);
      return null;
    });
    if (readable == null) return false;

    return pipeline(readable, fs.createWriteStream(path)).then(() => true).catch((error) => {
      state.logger?.error(error);
      return false;
    });
  },
};

const ui = {
  async input(query) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(query, (answer) => {
        resolve(answer);
        rl.close();
      });
    });
  },
};

const utils = {
  // updater removido - modo empresarial sin auto-actualizaciones
  // updater,
  discord,
  whatsapp,
  // sqliteToJson removido - modo empresarial sin auto-actualizaciones
  // sqliteToJson,
  ensureDownloadServer,
  stopDownloadServer,
};

export default utils;
