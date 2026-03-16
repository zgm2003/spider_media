/**
 * 媒体嗅探下载器 - Service Worker
 * 监听所有标签页的网络请求，捕获音频/视频/图片资源
 */

const tabMedia = {}
const DEFAULT_CAPTURE_SETTINGS = {
  video: true,
  image: true,
  audio: true,
  other: true,
}
let captureSettings = { ...DEFAULT_CAPTURE_SETTINGS }

const MEDIA_EXTS = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus|mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd|jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i
const AUDIO_EXTS = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus)(\?|$)/i
const VIDEO_EXTS = /\.(mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd)(\?|$)/i
const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i

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
    name: 'generic',
    host: /.*/,
    extraMediaExt: null,
    extraIgnore: [],
  },
]

function getHostFromUrl(url) {
  try {
    return new URL(url).hostname
  } catch (_) {
    return ''
  }
}

function getPlatformStrategy(url) {
  const host = getHostFromUrl(url)
  return PLATFORM_STRATEGIES.find((s) => s.host.test(host)) || PLATFORM_STRATEGIES[PLATFORM_STRATEGIES.length - 1]
}

function categoryScore(category) {
  return category === 'other' ? 0 : 1
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

function isCategoryEnabled(category) {
  const key = ['video', 'image', 'audio'].includes(category) ? category : 'other'
  return !!captureSettings[key]
}

chrome.storage.local.get(['captureSettings'], (data) => {
  captureSettings = normalizeSettings(data.captureSettings)
})

function inferCategory(url, contentType = '') {
  const ct = String(contentType).toLowerCase()
  if (ct.startsWith('audio/')) return 'audio'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('image/')) return 'image'
  if (ct.includes('mpegurl') || ct.includes('mp2t') || ct.includes('dash+xml') || ct.includes('x-flv')) return 'video'
  if (ct.includes('ogg') || ct.includes('mpeg') || ct.includes('aac')) return 'audio'

  if (AUDIO_EXTS.test(url)) return 'audio'
  if (VIDEO_EXTS.test(url)) return 'video'
  if (IMAGE_EXTS.test(url)) return 'image'
  if (/\.m3u8(\?|$)/i.test(url) || /\.ts(\?|$)/i.test(url) || /\.m4s(\?|$)/i.test(url) || /\.mpd(\?|$)/i.test(url)) return 'video'

  return 'other'
}

function sanitizeFilename(name) {
  return String(name || 'media').replace(/[\\/:*?"<>|]/g, '_').trim() || 'media'
}

function buildDownloadPath(filename, category) {
  const safeName = sanitizeFilename(filename)
  const folder = ['audio', 'video', 'image'].includes(category) ? category : 'other'
  return `${folder}/${safeName}`
}

function formatSize(contentLength) {
  if (!contentLength) return ''
  const bytes = parseInt(contentLength, 10)
  if (Number.isNaN(bytes) || bytes < 0) return ''
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

function ensureTabMedia(tabId) {
  if (!tabMedia[tabId]) tabMedia[tabId] = []
}

function safeDownload(options, sendResponse) {
  chrome.downloads.download(options, (downloadId) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message || 'download failed' })
      return
    }
    sendResponse({ ok: !!downloadId, downloadId, filename: options.filename })
  })
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('blob 转换失败'))
    reader.readAsDataURL(blob)
  })
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null)
    })
  })
}

function fetchBlobFromTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'fetchBlob', url }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || 'tab fetch failed' })
        return
      }
      resolve(resp || { ok: false, error: 'tab fetch failed' })
    })
  })
}

async function resolveMediaDataUrl(url, preferTabId) {
  try {
    const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    return await blobToDataUrl(blob)
  } catch (bgErr) {
    const tabId = preferTabId || (await getActiveTabId())
    if (!tabId) throw bgErr
    const tabResp = await fetchBlobFromTab(tabId, url)
    if (!tabResp?.ok || !tabResp?.dataUrl) throw new Error(tabResp?.error || bgErr.message)
    return tabResp.dataUrl
  }
}

function mergeMediaRecord(oldItem, newItem) {
  const oldCategory = oldItem.category || 'other'
  const newCategory = newItem.category || 'other'
  const preferNewCategory = categoryScore(newCategory) > categoryScore(oldCategory)

  return {
    ...oldItem,
    ...newItem,
    category: preferNewCategory ? newCategory : oldCategory,
    contentType: newItem.contentType || oldItem.contentType || '',
    size: newItem.size || oldItem.size || '',
    referer: newItem.referer || oldItem.referer || '',
    filename: newItem.filename || oldItem.filename || 'media',
    source: newItem.source || oldItem.source || 'unknown',
    time: oldItem.time || newItem.time || Date.now(),
  }
}

function extractFilename(url) {
  let filename = 'media'
  try {
    const pathname = new URL(url).pathname
    const name = pathname.split('/').pop()
    if (name && name.length > 1) filename = decodeURIComponent(name.split('?')[0])
  } catch (_) {}
  return sanitizeFilename(filename)
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return

    const url = details.url
    if (!url.startsWith('http')) return
    const strategy = getPlatformStrategy(url)
    if (IGNORE_PATTERNS.some((p) => p.test(url))) return
    if ((strategy.extraIgnore || []).some((p) => p.test(url))) return

    const contentType = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value || ''
    const contentLength = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-length')?.value || ''

    const isMediaType = MEDIA_TYPES.test(contentType)
    const isMediaExt = MEDIA_EXTS.test(url)
    const isStrategyMedia = !!strategy.extraMediaExt && strategy.extraMediaExt.test(url)
    if (!isMediaType && !isMediaExt && !isStrategyMedia) return

    const referer = tabMedia._refererCache?.[url] || ''
    const filename = extractFilename(url)
    const category = inferCategory(url, contentType)
    if (!isCategoryEnabled(category)) return

    ensureTabMedia(details.tabId)
    const nextItem = {
      url,
      filename,
      category,
      platform: strategy.name,
      contentType,
      size: formatSize(contentLength),
      referer,
      time: Date.now(),
      source: 'webRequest',
    }
    const existingIdx = tabMedia[details.tabId].findIndex((m) => m.url === url)
    if (existingIdx >= 0) {
      tabMedia[details.tabId][existingIdx] = mergeMediaRecord(tabMedia[details.tabId][existingIdx], nextItem)
    } else {
      tabMedia[details.tabId].push(nextItem)
    }

    updateBadge(details.tabId)
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return
    const referer = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'referer')?.value
    if (referer) {
      if (!tabMedia._refererCache) tabMedia._refererCache = {}
      tabMedia._refererCache[details.url] = referer
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
)

function updateBadge(tabId) {
  const count = tabMedia[tabId]?.length || 0
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId })
  chrome.action.setBadgeBackgroundColor({ color: '#409eff', tabId })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabMedia[tabId]
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'mediaFound') {
    const tabId = sender.tab?.id
    if (!tabId || tabId < 0) return

    ensureTabMedia(tabId)
    const nextItem = {
      url: msg.url,
      filename: sanitizeFilename(msg.filename || extractFilename(msg.url)),
      category: msg.category || inferCategory(msg.url, msg.contentType || ''),
      platform: msg.platform || getPlatformStrategy(msg.url).name,
      contentType: msg.contentType || '',
      size: '',
      referer: msg.referer || sender.tab?.url || '',
      time: Date.now(),
      source: msg.source || 'content',
    }
    if (!isCategoryEnabled(nextItem.category)) return
    const existingIdx = tabMedia[tabId].findIndex((m) => m.url === msg.url)
    if (existingIdx >= 0) {
      tabMedia[tabId][existingIdx] = mergeMediaRecord(tabMedia[tabId][existingIdx], nextItem)
    } else {
      tabMedia[tabId].push(nextItem)
    }
    updateBadge(tabId)
    return
  }

  if (msg.type === 'getMedia') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      const media = tabId ? [...(tabMedia[tabId] || [])] : []
      media.forEach((m) => {
        if (!m.referer && tabMedia._refererCache?.[m.url]) m.referer = tabMedia._refererCache[m.url]
        if (!m.referer && tabs[0]?.url) m.referer = tabs[0].url
      })
      sendResponse({ media, tabUrl: tabs[0]?.url || '' })
    })
    return true
  }

  if (msg.type === 'getCaptureSettings') {
    sendResponse({ settings: captureSettings })
    return true
  }

  if (msg.type === 'setCaptureSettings') {
    captureSettings = normalizeSettings(msg.settings)
    chrome.storage.local.set({ captureSettings })
    Object.keys(tabMedia).forEach((k) => {
      const tabId = parseInt(k, 10)
      if (Number.isNaN(tabId)) return
      tabMedia[tabId] = (tabMedia[tabId] || []).filter((m) => isCategoryEnabled(m.category || 'other'))
      updateBadge(tabId)
    })
    sendResponse({ ok: true, settings: captureSettings })
    return true
  }

  if (msg.type === 'getMediaForTab') {
    const tabId = sender.tab?.id
    const tabUrl = sender.tab?.url || ''
    const media = tabId ? [...(tabMedia[tabId] || [])] : []
    media.forEach((m) => {
      if (!m.referer && tabMedia._refererCache?.[m.url]) m.referer = tabMedia._refererCache[m.url]
      if (!m.referer && tabUrl) m.referer = tabUrl
    })
    sendResponse({ media, tabUrl })
    return true
  }

  if (msg.type === 'clearMedia') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) {
        tabMedia[tabId] = []
        updateBadge(tabId)
      }
      sendResponse({ ok: true })
    })
    return true
  }

  if (msg.type === 'clearMediaForTab') {
    const tabId = sender.tab?.id
    if (tabId) {
      tabMedia[tabId] = []
      updateBadge(tabId)
    }
    sendResponse({ ok: true })
    return true
  }

  if (msg.type === 'download') {
    const url = msg.url
    const category = msg.category || inferCategory(url, msg.contentType || '')
    const filename = buildDownloadPath(msg.filename || extractFilename(url), category)

    resolveMediaDataUrl(url, sender.tab?.id)
      .then((dataUrl) => {
        safeDownload({ url: dataUrl, filename }, sendResponse)
      })
      .catch((bgErr) => {
        safeDownload({ url, filename }, (fallbackResp) => {
          if (fallbackResp.ok) {
            sendResponse(fallbackResp)
          } else {
            sendResponse({ ok: false, error: `所有方式均失败: ${bgErr.message}; ${fallbackResp.error || ''}` })
          }
        })
      })
    return true
  }
})
