/**
 * 媒体嗅探器 - 共享规则层
 * 负责媒体识别、下载模式判断、消息协议和通用工具函数。
 */

;(function (global) {
  'use strict'

  const CATEGORY_KEYS = ['video', 'image', 'audio', 'other']
  const DEFAULT_CAPTURE_SETTINGS = {
    video: true,
    image: true,
    audio: true,
    other: true,
  }
  const MAX_MEDIA_PER_TAB = 500
  const MAX_INLINE_DOWNLOAD_BYTES = 20 * 1024 * 1024
  const MIN_VISIBLE_IMAGE_BYTES = 2 * 1024
  const MIN_VISIBLE_AUDIO_BYTES = 16 * 1024
  const MIN_VISIBLE_VIDEO_BYTES = 24 * 1024
  const MIN_VISIBLE_OTHER_BYTES = 32 * 1024
  const MIN_VISIBLE_SEGMENT_BYTES = 1024 * 1024

  const AUDIO_EXTS = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus)(\?|$)/i
  const VIDEO_EXTS = /\.(mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd)(\?|$)/i
  const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i
  const STREAM_MANIFEST_EXTS = /\.(m3u8|mpd)(\?|$)/i
  const STREAM_SEGMENT_EXTS = /\.(ts|m4s)(\?|$)/i
  const MEDIA_EXTS = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus|mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd|jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i
  const MEDIA_TYPES = /^(audio|video|image)\//i

  const IGNORE_PATTERNS = [
    /google/i,
    /analytics/i,
    /favicon/i,
    /notification/i,
    /click\.(mp3|wav)/i,
    /beep/i,
    /ding/i,
  ]

  const PLATFORM_STRATEGIES = [
    {
      name: 'aigei',
      host: /(^|\.)aigei\.com$/i,
      extraMediaExt: /\.(zip|rar)(\?|$)/i,
      extraIgnore: [],
    },
    {
      name: 'bilibili',
      host: /(^|\.)(bilibili\.com|bilivideo\.com|bilivideo\.cn|akamaized\.net)$/i,
      extraMediaExt: null,
      extraIgnore: [/\/tracker\?/i, /\/web-interface\/report/i, /\/x\/report/i],
      downloadHint: 'B站视频与音频为分离的 m4s 文件，需用 ffmpeg 合并：ffmpeg -i video.m4s -i audio.m4s -c copy output.mp4',
    },
    {
      name: 'douyin',
      host: /(^|\.)(douyin\.com|douyinvod\.com|zjcdn\.com|snssdk\.com)$/i,
      extraMediaExt: null,
      extraIgnore: [/\/log_settings/i, /\/frontier\//i, /\/webcast\//i, /\/aweme\/v1\/web\/report/i],
      downloadHint: '抖音视频链接有时效性，过期后需重新打开页面捕获。',
    },
    {
      name: 'youtube',
      host: /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i,
      extraMediaExt: null,
      extraIgnore: [/\/generate_204/i, /\/log_event/i, /\/ptracking/i, /\/api\/stats/i],
      downloadHint: 'YouTube 视频与音频可能分离传输。建议使用 yt-dlp 直接下载页面地址以获取最佳画质。',
    },
    {
      name: 'tiktok',
      host: /(^|\.)(tiktok\.com|tiktokcdn\.com|musical\.ly)$/i,
      extraMediaExt: null,
      extraIgnore: [/\/log\//i, /\/report\//i],
    },
    {
      name: 'twitter',
      host: /(^|\.)(twitter\.com|x\.com|twimg\.com|video\.twimg\.com)$/i,
      extraMediaExt: null,
      extraIgnore: [],
    },
    {
      name: 'generic',
      host: /.*/,
      extraMediaExt: null,
      extraIgnore: [],
    },
  ]

  const MESSAGE_TYPES = {
    MEDIA_FOUND: 'mediaFound',
    GET_MEDIA: 'getMedia',
    GET_MEDIA_FOR_TAB: 'getMediaForTab',
    CLEAR_MEDIA: 'clearMedia',
    CLEAR_MEDIA_FOR_TAB: 'clearMediaForTab',
    DOWNLOAD: 'download',
    FETCH_BLOB: 'fetchBlob',
    FETCH_TEXT: 'fetchText',
    GET_STREAM_CONTEXT: 'getStreamContext',
    SET_MEDIA_STATUS: 'setMediaStatus',
    TOGGLE_DOCK_PANEL: 'toggleDockPanel',
    GET_CAPTURE_SETTINGS: 'getCaptureSettings',
    SET_CAPTURE_SETTINGS: 'setCaptureSettings',
    MEDIA_UPDATED: 'mediaUpdated',
  }

  const BRIDGE_EVENT_NAME = 'media-sniffer:bridge-found'

  function toAbsoluteUrl(url, base) {
    try {
      return new URL(url, base).href
    } catch (_) {
      return String(url || '')
    }
  }

  function getHostFromUrl(url, base) {
    try {
      return new URL(url, base).hostname
    } catch (_) {
      return ''
    }
  }

  function getPlatformStrategy(url, base) {
    const host = getHostFromUrl(url, base)
    return PLATFORM_STRATEGIES.find((item) => item.host.test(host)) || PLATFORM_STRATEGIES[PLATFORM_STRATEGIES.length - 1]
  }

  function getOrigin(url, base) {
    try {
      return new URL(url, base).origin
    } catch (_) {
      return ''
    }
  }

  function isBlobUrl(url, base) {
    return /^blob:/i.test(toAbsoluteUrl(url, base))
  }

  function isHttpUrl(url, base) {
    return /^https?:/i.test(toAbsoluteUrl(url, base))
  }

  function normalizeSettings(raw) {
    const obj = raw || {}
    return {
      video: obj.video !== false,
      image: obj.image !== false,
      audio: obj.audio !== false,
      other: obj.other !== false,
    }
  }

  function isCategoryEnabled(settings, category) {
    const key = CATEGORY_KEYS.includes(category) ? category : 'other'
    return !!normalizeSettings(settings)[key]
  }

  function inferCategory(url, contentType, categoryHint) {
    const hint = String(categoryHint || '').toLowerCase()
    if (hint === 'audio' || hint === 'video' || hint === 'image') return hint

    const ct = String(contentType || '').toLowerCase()
    if (ct.startsWith('audio/')) return 'audio'
    if (ct.startsWith('video/')) return 'video'
    if (ct.startsWith('image/')) return 'image'
    if (ct.includes('mpegurl') || ct.includes('mp2t') || ct.includes('dash+xml') || ct.includes('x-flv')) return 'video'
    if (ct.includes('ogg') || ct.includes('mpeg') || ct.includes('aac')) return 'audio'

    const absUrl = toAbsoluteUrl(url)
    if (AUDIO_EXTS.test(absUrl)) return 'audio'
    if (VIDEO_EXTS.test(absUrl)) return 'video'
    if (IMAGE_EXTS.test(absUrl)) return 'image'

    return 'other'
  }

  function normalizeCategory(item) {
    return inferCategory(item?.url || '', item?.contentType || '', item?.category || item?.categoryHint || '')
  }

  function sanitizeFilename(name) {
    return String(name || 'media').replace(/[\\/:*?"<>|]/g, '_').trim() || 'media'
  }

  function extractFilename(url, fallbackName) {
    let filename = fallbackName || 'media'
    try {
      const pathname = new URL(url).pathname
      const tail = pathname.split('/').pop()
      if (tail && tail.length > 1) filename = decodeURIComponent(tail.split('?')[0])
    } catch (_) {}
    return sanitizeFilename(filename)
  }

  function replaceFileExtension(filename, nextExt) {
    const safeName = sanitizeFilename(filename || 'media')
    const ext = String(nextExt || '').replace(/^\./, '')
    const base = safeName.replace(/\.[^.]+$/, '')
    return ext ? `${base}.${ext}` : base
  }

  function buildDownloadPath(filename, category) {
    const folder = category === 'audio' || category === 'video' || category === 'image' ? category : 'other'
    return `${folder}/${sanitizeFilename(filename)}`
  }

  function parseContentLength(value) {
    const bytes = parseInt(value, 10)
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
  }

  function buildMediaKey(url, _referer, frameId, base) {
    const absUrl = toAbsoluteUrl(url, base)
    const framePart = Number.isInteger(frameId) ? String(frameId) : 'top'
    return `${absUrl}|${framePart}`
  }

  function formatSize(value) {
    const bytes = parseContentLength(value)
    if (!bytes) return ''
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
    if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB'
    return bytes + ' B'
  }

  function shouldCaptureResource(url, contentType, base) {
    const absUrl = toAbsoluteUrl(url, base)
    if (!absUrl || absUrl.startsWith('chrome-extension://')) return false
    if (!isHttpUrl(absUrl) && !isBlobUrl(absUrl)) return false
    if (IGNORE_PATTERNS.some((pattern) => pattern.test(absUrl))) return false

    const strategy = getPlatformStrategy(absUrl, base)
    if ((strategy.extraIgnore || []).some((pattern) => pattern.test(absUrl))) return false
    if (isBlobUrl(absUrl)) return true

    return (
      MEDIA_TYPES.test(contentType || '') ||
      MEDIA_EXTS.test(absUrl) ||
      (!!strategy.extraMediaExt && strategy.extraMediaExt.test(absUrl))
    )
  }

  function isStreamManifest(url, contentType) {
    const absUrl = toAbsoluteUrl(url)
    const ct = String(contentType || '').toLowerCase()
    return STREAM_MANIFEST_EXTS.test(absUrl) || ct.includes('mpegurl') || ct.includes('dash+xml')
  }

  function isStreamSegment(url, contentType) {
    const absUrl = toAbsoluteUrl(url)
    const ct = String(contentType || '').toLowerCase()
    return STREAM_SEGMENT_EXTS.test(absUrl) || ct.includes('mp2t')
  }

  function getDownloadMode(record) {
    const url = record?.url || ''
    const contentType = record?.contentType || ''
    if (isBlobUrl(url)) return 'frame-fetch'
    if (isStreamManifest(url, contentType)) return 'manifest'
    if (isStreamSegment(url, contentType)) return 'segment'
    if ((record?.sizeBytes || 0) > MAX_INLINE_DOWNLOAD_BYTES) return 'direct'
    return 'smart'
  }

  function getDownloadNotice(record) {
    const mode = getDownloadMode(record)
    if (mode === 'manifest') return '检测到流媒体索引文件，建议先分析或复制 ffmpeg 命令，而不是直接下载索引文件。'
    if (mode === 'segment') {
      const strategy = getPlatformStrategy(record?.url || '')
      const hint = strategy.downloadHint || ''
      return '检测到流媒体分片，这个文件只是整段流媒体中的一个切片。' + (hint ? ' ' + hint : '')
    }
    return ''
  }

  function isLikelyUsefulResource(record) {
    if (!record) return false

    const category = normalizeCategory(record)
    const mode = getDownloadMode(record)
    const sizeBytes = parseContentLength(record.sizeBytes)
    const sourceList = Array.isArray(record.sourceList) ? record.sourceList : []
    const hasStructuredMetadata = !!record.biliMeta
    const isDomDiscovered = sourceList.some((value) => /^(scan|element|page-)/i.test(String(value || '')))

    if (record.status === 'downloaded' || record.status === 'exported') return true
    if (hasStructuredMetadata || isBlobUrl(record.url, record.referer || '')) return true
    if (mode === 'manifest') return true

    if (mode === 'segment') {
      if (hasStructuredMetadata) return true
      return sizeBytes >= MIN_VISIBLE_SEGMENT_BYTES
    }

    if (!sizeBytes) {
      return category !== 'other' || isDomDiscovered
    }

    if (category === 'image') return sizeBytes >= MIN_VISIBLE_IMAGE_BYTES
    if (category === 'audio') return sizeBytes >= MIN_VISIBLE_AUDIO_BYTES
    if (category === 'video') return sizeBytes >= MIN_VISIBLE_VIDEO_BYTES
    return sizeBytes >= MIN_VISIBLE_OTHER_BYTES
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  global.MediaSnifferShared = {
    AUDIO_EXTS,
    BRIDGE_EVENT_NAME,
    CATEGORY_KEYS,
    DEFAULT_CAPTURE_SETTINGS,
    IMAGE_EXTS,
    MAX_INLINE_DOWNLOAD_BYTES,
    MAX_MEDIA_PER_TAB,
    MESSAGE_TYPES,
    PLATFORM_STRATEGIES,
    STREAM_MANIFEST_EXTS,
    STREAM_SEGMENT_EXTS,
    VIDEO_EXTS,
    buildDownloadPath,
    buildMediaKey,
    escapeHtml,
    extractFilename,
    formatSize,
    getDownloadMode,
    getDownloadNotice,
    getHostFromUrl,
    getOrigin,
    getPlatformStrategy,
    inferCategory,
    isBlobUrl,
    isCategoryEnabled,
    isHttpUrl,
    isLikelyUsefulResource,
    isStreamManifest,
    isStreamSegment,
    normalizeCategory,
    normalizeSettings,
    parseContentLength,
    replaceFileExtension,
    sanitizeFilename,
    shouldCaptureResource,
    toAbsoluteUrl,
  }
})(globalThis)
