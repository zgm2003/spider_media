/**
 * 媒体嗅探器 - 后台服务
 * 负责按标签页维护资源状态、执行下载、分析流媒体索引并向界面推送更新。
 */

importScripts('shared.js')

const Shared = globalThis.MediaSnifferShared
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
const STREAM_CACHE_TTL_MS = 5 * 60 * 1000
const STREAM_CACHE_LIMIT = 120

const mediaByTab = new Map()
const refererByRequestId = new Map()
const streamContextCache = new Map()
let captureSettings = { ...Shared.DEFAULT_CAPTURE_SETTINGS }

chrome.storage.local.get(['captureSettings'], (data) => {
  captureSettings = Shared.normalizeSettings(data.captureSettings)
})

function getTabState(tabId) {
  if (!mediaByTab.has(tabId)) {
    mediaByTab.set(tabId, { recordsByUrl: new Map() })
  }
  return mediaByTab.get(tabId)
}

function listTabMedia(tabId, fallbackReferer) {
  const records = Array.from(mediaByTab.get(tabId)?.recordsByUrl.values() || [])
  return records.map((item) => ({
    ...item,
    referer: item.referer || fallbackReferer || '',
  }))
}

function categoryScore(category) {
  return category === 'other' ? 0 : 1
}

function decorateMediaRecord(record) {
  const category = Shared.normalizeCategory(record)
  return {
    ...record,
    category,
    filename: Shared.sanitizeFilename(record.filename || Shared.extractFilename(record.url)),
    downloadMode: Shared.getDownloadMode({ ...record, category }),
    downloadNotice: Shared.getDownloadNotice({ ...record, category }),
  }
}

function mergeMediaRecord(oldItem, newItem) {
  const oldCategory = oldItem.category || 'other'
  const newCategory = newItem.category || 'other'
  const preferNewCategory = categoryScore(newCategory) > categoryScore(oldCategory)

  return decorateMediaRecord({
    ...oldItem,
    ...newItem,
    id: oldItem.id || newItem.id,
    category: preferNewCategory ? newCategory : oldCategory,
    categoryHint: newItem.categoryHint || oldItem.categoryHint || '',
    contentType: newItem.contentType || oldItem.contentType || '',
    size: newItem.size || oldItem.size || '',
    sizeBytes: newItem.sizeBytes || oldItem.sizeBytes || 0,
    referer: newItem.referer || oldItem.referer || '',
    filename: newItem.filename || oldItem.filename || 'media',
    frameId: Number.isInteger(newItem.frameId) ? newItem.frameId : oldItem.frameId,
    platform: newItem.platform || oldItem.platform || 'generic',
    source: newItem.source || oldItem.source || 'unknown',
    time: newItem.time || oldItem.time || Date.now(),
  })
}

function trimTabState(state) {
  while (state.recordsByUrl.size > Shared.MAX_MEDIA_PER_TAB) {
    const firstKey = state.recordsByUrl.keys().next().value
    state.recordsByUrl.delete(firstKey)
  }
}

function ignoreLastError() {
  void chrome.runtime.lastError
}

function updateBadge(tabId) {
  const count = mediaByTab.get(tabId)?.recordsByUrl.size || 0
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId })
  chrome.action.setBadgeBackgroundColor({ color: '#409eff', tabId })
}

function notifyMediaUpdated(tabId) {
  updateBadge(tabId)

  chrome.tabs.sendMessage(
    tabId,
    {
      type: Shared.MESSAGE_TYPES.MEDIA_UPDATED,
      tabId,
      count: mediaByTab.get(tabId)?.recordsByUrl.size || 0,
    },
    ignoreLastError
  )

  chrome.runtime.sendMessage(
    {
      type: Shared.MESSAGE_TYPES.MEDIA_UPDATED,
      tabId,
      count: mediaByTab.get(tabId)?.recordsByUrl.size || 0,
    },
    ignoreLastError
  )
}

function upsertMediaRecord(tabId, nextItem) {
  const state = getTabState(tabId)
  const existing = state.recordsByUrl.get(nextItem.url)
  const normalized = decorateMediaRecord({
    ...nextItem,
    id: existing?.id || nextItem.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  })

  if (!Shared.isCategoryEnabled(captureSettings, normalized.category)) return

  state.recordsByUrl.set(nextItem.url, existing ? mergeMediaRecord(existing, normalized) : normalized)
  trimTabState(state)
  notifyMediaUpdated(tabId)
}

function filterByCaptureSettings() {
  for (const [tabId, state] of mediaByTab.entries()) {
    for (const [url, item] of state.recordsByUrl.entries()) {
      if (!Shared.isCategoryEnabled(captureSettings, item.category || 'other')) {
        state.recordsByUrl.delete(url)
      }
    }
    notifyMediaUpdated(tabId)
  }
}

function clearTabMedia(tabId) {
  if (!mediaByTab.has(tabId)) return
  mediaByTab.get(tabId).recordsByUrl.clear()
  notifyMediaUpdated(tabId)
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Blob 转换失败'))
    reader.readAsDataURL(blob)
  })
}

function downloadFile(options) {
  return new Promise((resolve) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || '下载失败' })
        return
      }
      resolve({ ok: !!downloadId, downloadId, filename: options.filename })
    })
  })
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null)
    })
  })
}

function fetchBlobFromTab(tabId, frameId, url) {
  return new Promise((resolve) => {
    const callback = (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || '页面内 Blob 抓取失败' })
        return
      }
      resolve(resp || { ok: false, error: '页面内 Blob 抓取失败' })
    }

    if (Number.isInteger(frameId)) {
      chrome.tabs.sendMessage(tabId, { type: Shared.MESSAGE_TYPES.FETCH_BLOB, url }, { frameId }, callback)
      return
    }

    chrome.tabs.sendMessage(tabId, { type: Shared.MESSAGE_TYPES.FETCH_BLOB, url }, callback)
  })
}

function fetchTextFromTab(tabId, frameId, url) {
  return new Promise((resolve) => {
    const callback = (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || '页面内文本抓取失败' })
        return
      }
      resolve(resp || { ok: false, error: '页面内文本抓取失败' })
    }

    if (Number.isInteger(frameId)) {
      chrome.tabs.sendMessage(tabId, { type: Shared.MESSAGE_TYPES.FETCH_TEXT, url }, { frameId }, callback)
      return
    }

    chrome.tabs.sendMessage(tabId, { type: Shared.MESSAGE_TYPES.FETCH_TEXT, url }, callback)
  })
}

async function resolveMediaDataUrl(record, tabId) {
  if (Shared.isBlobUrl(record.url)) {
    const tabResp = await fetchBlobFromTab(tabId, record.frameId, record.url)
    if (!tabResp?.ok || !tabResp?.dataUrl) throw new Error(tabResp?.error || 'Blob 下载失败')
    return tabResp.dataUrl
  }

  try {
    const resp = await fetch(record.url, { credentials: 'omit', cache: 'no-store' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    return await blobToDataUrl(blob)
  } catch (bgErr) {
    const tabResp = await fetchBlobFromTab(tabId, record.frameId, record.url)
    if (!tabResp?.ok || !tabResp?.dataUrl) throw new Error(tabResp?.error || bgErr.message)
    return tabResp.dataUrl
  }
}

function parseAttributeList(line) {
  const source = String(line || '').split(':').slice(1).join(':')
  const attrs = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^",]*)/gi
  let match = re.exec(source)
  while (match) {
    let value = match[2] || ''
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    attrs[match[1].toLowerCase()] = value
    match = re.exec(source)
  }
  return attrs
}

function parseIsoDurationToSeconds(value) {
  const match = String(value || '').match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
  )
  if (!match) return 0

  const years = parseFloat(match[1] || 0)
  const months = parseFloat(match[2] || 0)
  const days = parseFloat(match[3] || 0)
  const hours = parseFloat(match[4] || 0)
  const minutes = parseFloat(match[5] || 0)
  const seconds = parseFloat(match[6] || 0)
  return Math.round(years * 31536000 + months * 2592000 + days * 86400 + hours * 3600 + minutes * 60 + seconds)
}

function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remain = seconds % 60

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`
  return `${minutes}:${String(remain).padStart(2, '0')}`
}

function parseHlsManifest(text, manifestUrl) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length || lines[0] !== '#EXTM3U') {
    throw new Error('无效的 HLS 索引文件')
  }

  let variantCount = 0
  let segmentCount = 0
  let encrypted = false
  let targetDuration = 0
  let playlistType = ''
  let hasEndList = false
  let firstVariantUrl = ''
  let firstSegmentUrl = ''
  let waitingVariantUrl = false

  const resolutions = []
  const bandwidths = []

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      variantCount += 1
      waitingVariantUrl = true
      const attrs = parseAttributeList(line)
      if (attrs.resolution) resolutions.push(attrs.resolution)
      if (attrs.bandwidth) {
        const numericBandwidth = parseInt(attrs.bandwidth, 10)
        if (Number.isFinite(numericBandwidth)) bandwidths.push(numericBandwidth)
      }
      continue
    }

    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      variantCount += 1
      const attrs = parseAttributeList(line)
      if (attrs.uri && !firstVariantUrl) firstVariantUrl = Shared.toAbsoluteUrl(attrs.uri, manifestUrl)
      continue
    }

    if (line.startsWith('#EXT-X-KEY')) encrypted = true
    if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseInt(line.split(':')[1] || '0', 10) || 0
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = (line.split(':')[1] || '').trim()
    if (line.startsWith('#EXT-X-ENDLIST')) hasEndList = true

    if (line.startsWith('#')) continue

    const absoluteUrl = Shared.toAbsoluteUrl(line, manifestUrl)
    if (waitingVariantUrl) {
      if (!firstVariantUrl) firstVariantUrl = absoluteUrl
      waitingVariantUrl = false
      continue
    }

    segmentCount += 1
    if (!firstSegmentUrl) firstSegmentUrl = absoluteUrl
  }

  const manifestType = variantCount > 0 ? 'master' : 'media'
  const isLive = manifestType === 'media' ? !hasEndList && String(playlistType).toUpperCase() !== 'VOD' : false
  const bandwidthSummary = bandwidths.length
    ? `${Math.round(Math.min(...bandwidths) / 1000)}-${Math.round(Math.max(...bandwidths) / 1000)} kbps`
    : ''

  const details = []
  if (targetDuration) details.push(`目标分片时长 ${targetDuration}s`)
  if (resolutions.length) details.push(`分辨率 ${resolutions.slice(0, 3).join(', ')}`)
  if (bandwidthSummary) details.push(`码率 ${bandwidthSummary}`)
  if (firstVariantUrl) details.push(`示例变体 ${firstVariantUrl}`)
  if (firstSegmentUrl) details.push(`首个分片 ${firstSegmentUrl}`)

  return {
    kind: 'hls',
    manifestType,
    variantCount,
    segmentCount,
    encrypted,
    isLive,
    playlistType: playlistType || (isLive ? 'LIVE' : 'VOD'),
    targetDuration,
    details,
    summary: [
      manifestType === 'master' ? 'HLS 主索引' : 'HLS 媒体列表',
      manifestType === 'master' ? `${variantCount} 个变体` : `${segmentCount} 个分片`,
      encrypted ? '已加密' : '未加密',
      manifestType === 'media' ? (isLive ? '直播' : '点播') : '',
    ]
      .filter(Boolean)
      .join(' | '),
  }
}

function getXmlAttribute(tagText, attrName) {
  const re = new RegExp(`${attrName}="([^"]+)"`, 'i')
  const match = String(tagText || '').match(re)
  return match?.[1] || ''
}

function parseDashManifest(text, manifestUrl) {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const mpdTag = source.match(/<MPD\b[^>]*>/i)?.[0] || ''
  if (!mpdTag) throw new Error('无效的 DASH 索引文件')

  const type = getXmlAttribute(mpdTag, 'type') || 'static'
  const durationRaw = getXmlAttribute(mpdTag, 'mediaPresentationDuration')
  const adaptationSetCount = (source.match(/<AdaptationSet\b/gi) || []).length
  const representationCount = (source.match(/<Representation\b/gi) || []).length
  const segmentTemplateCount = (source.match(/<SegmentTemplate\b/gi) || []).length
  const segmentTimelineEntryCount = (source.match(/<S\b/gi) || []).length
  const encrypted = /<ContentProtection\b/i.test(source)
  const firstBaseUrl = source.match(/<BaseURL>([^<]+)<\/BaseURL>/i)?.[1]?.trim() || ''
  const durationSeconds = parseIsoDurationToSeconds(durationRaw)
  const isLive = type.toLowerCase() === 'dynamic'

  const details = []
  if (adaptationSetCount) details.push(`${adaptationSetCount} 个 AdaptationSet`)
  if (segmentTemplateCount) details.push(`${segmentTemplateCount} 个 SegmentTemplate 节点`)
  if (segmentTimelineEntryCount) details.push(`${segmentTimelineEntryCount} 条时间线条目`)
  if (durationSeconds) details.push(`时长 ${formatSeconds(durationSeconds)}`)
  if (firstBaseUrl) details.push(`基础地址 ${Shared.toAbsoluteUrl(firstBaseUrl, manifestUrl)}`)

  return {
    kind: 'dash',
    manifestType: 'mpd',
    representationCount,
    adaptationSetCount,
    segmentTemplateCount,
    segmentTimelineEntryCount,
    encrypted,
    isLive,
    durationSeconds,
    details,
    summary: [
      'DASH 索引',
      representationCount ? `${representationCount} 个表示层` : '',
      encrypted ? '已加密' : '未加密',
      isLive ? '直播' : '点播',
    ]
      .filter(Boolean)
      .join(' | '),
  }
}

function getOrigin(url) {
  try {
    return new URL(url).origin
  } catch (_) {
    return ''
  }
}

function escapePowerShellArgument(value) {
  return String(value || '')
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
}

function buildStreamOutputFilename(record) {
  return Shared.replaceFileExtension(record.filename || Shared.extractFilename(record.url), 'mp4')
}

function buildFfmpegCommand(record) {
  const parts = ['ffmpeg']
  parts.push(`-user_agent "${escapePowerShellArgument(DEFAULT_USER_AGENT)}"`)

  if (record.referer) {
    parts.push(`-referer "${escapePowerShellArgument(record.referer)}"`)
  }

  const origin = getOrigin(record.referer || record.url)
  if (origin) {
    parts.push(`-headers "Origin: ${escapePowerShellArgument(origin)}"`)
  }

  parts.push(`-i "${escapePowerShellArgument(record.url)}"`)
  parts.push('-c copy')
  parts.push(`"${escapePowerShellArgument(buildStreamOutputFilename(record))}"`)
  return parts.join(' ')
}

function getStreamCacheKey(record) {
  return `${record.url}|${record.referer || ''}|${record.frameId || ''}`
}

function cleanupStreamContextCache() {
  const now = Date.now()
  for (const [key, entry] of streamContextCache.entries()) {
    if (!entry || now - entry.updatedAt > STREAM_CACHE_TTL_MS) {
      streamContextCache.delete(key)
    }
  }

  while (streamContextCache.size > STREAM_CACHE_LIMIT) {
    const firstKey = streamContextCache.keys().next().value
    streamContextCache.delete(firstKey)
  }
}

async function fetchTextInBackground(url) {
  const credentialsModes = ['omit', 'include', 'same-origin']
  let lastError = new Error('后台文本抓取失败')

  for (const credentials of credentialsModes) {
    try {
      const response = await fetch(url, { credentials, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { ok: true, text: await response.text(), finalUrl: response.url || url }
    } catch (err) {
      lastError = err
    }
  }

  throw lastError
}

async function fetchStreamText(record, tabId) {
  try {
    return await fetchTextInBackground(record.url)
  } catch (bgErr) {
    const tabResp = await fetchTextFromTab(tabId, record.frameId, record.url)
    if (!tabResp?.ok || typeof tabResp.text !== 'string') {
      throw new Error(tabResp?.error || bgErr.message)
    }
    return { ok: true, text: tabResp.text, finalUrl: tabResp.finalUrl || record.url }
  }
}

async function getStreamContext(record, tabId, forceRefresh) {
  if (!Shared.isStreamManifest(record.url, record.contentType || '')) {
    throw new Error('当前选择的资源不是流媒体索引文件')
  }

  cleanupStreamContextCache()
  const cacheKey = getStreamCacheKey(record)
  if (!forceRefresh) {
    const cached = streamContextCache.get(cacheKey)
    if (cached && Date.now() - cached.updatedAt <= STREAM_CACHE_TTL_MS) {
      return {
        ...cached.context,
        command: buildFfmpegCommand(record),
      }
    }
  }

  const fetched = await fetchStreamText(record, tabId)
  const manifestUrl = fetched.finalUrl || record.url
  const analysis = /\.mpd(\?|$)/i.test(record.url) || /dash\+xml/i.test(record.contentType || '')
    ? parseDashManifest(fetched.text, manifestUrl)
    : parseHlsManifest(fetched.text, manifestUrl)

  const context = {
    kind: analysis.kind,
    summary: analysis.summary,
    details: analysis.details || [],
    analysis,
    analyzedAt: Date.now(),
  }

  streamContextCache.set(cacheKey, {
    updatedAt: Date.now(),
    context,
  })

  cleanupStreamContextCache()
  return {
    ...context,
    command: buildFfmpegCommand(record),
  }
}

async function handleDownloadRequest(msg, sender, sendResponse) {
  const tabId = msg.tabId || sender.tab?.id || (await getActiveTabId())
  if (!tabId) {
    sendResponse({ ok: false, error: '未找到目标标签页' })
    return
  }

  const record = decorateMediaRecord({
    url: msg.url,
    filename: msg.filename || Shared.extractFilename(msg.url),
    category: msg.category,
    categoryHint: msg.categoryHint,
    contentType: msg.contentType || '',
    sizeBytes: Shared.parseContentLength(msg.sizeBytes),
    frameId: Number.isInteger(msg.frameId) ? msg.frameId : sender.frameId,
    referer: msg.referer || '',
    time: Date.now(),
  })

  const filename = Shared.buildDownloadPath(record.filename, record.category)
  const mode = record.downloadMode
  const warning = record.downloadNotice

  if (mode === 'manifest' || mode === 'segment' || mode === 'direct') {
    const directResp = await downloadFile({ url: record.url, filename })
    sendResponse({ ...directResp, warning })
    return
  }

  try {
    const dataUrl = await resolveMediaDataUrl(record, tabId)
    const result = await downloadFile({ url: dataUrl, filename })
    sendResponse({ ...result, warning })
  } catch (err) {
    const fallbackResp = await downloadFile({ url: record.url, filename })
    if (fallbackResp.ok) {
      sendResponse({ ...fallbackResp, warning })
      return
    }
    sendResponse({
      ok: false,
      error: `所有下载方式都失败了：${err.message}; ${fallbackResp.error || ''}`,
      warning,
    })
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return
    const referer = details.requestHeaders?.find((header) => header.name.toLowerCase() === 'referer')?.value || ''
    if (referer) refererByRequestId.set(details.requestId, referer)
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
)

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return

    const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value || ''
    if (!Shared.shouldCaptureResource(details.url, contentType)) {
      refererByRequestId.delete(details.requestId)
      return
    }

    const category = Shared.inferCategory(details.url, contentType)
    if (!Shared.isCategoryEnabled(captureSettings, category)) {
      refererByRequestId.delete(details.requestId)
      return
    }

    const contentLength = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-length')?.value || ''
    const sizeBytes = Shared.parseContentLength(contentLength)
    upsertMediaRecord(details.tabId, {
      url: details.url,
      filename: Shared.extractFilename(details.url),
      category,
      platform: Shared.getPlatformStrategy(details.url).name,
      contentType,
      size: Shared.formatSize(contentLength),
      sizeBytes,
      referer: refererByRequestId.get(details.requestId) || '',
      frameId: details.frameId,
      time: Date.now(),
      source: 'webRequest',
    })
    refererByRequestId.delete(details.requestId)
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

chrome.webRequest.onErrorOccurred.addListener((details) => {
  refererByRequestId.delete(details.requestId)
}, { urls: ['<all_urls>'] })

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId)
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === Shared.MESSAGE_TYPES.MEDIA_FOUND) {
    const tabId = sender.tab?.id
    if (!tabId || tabId < 0) return false
    if (!Shared.shouldCaptureResource(msg.url, msg.contentType || '', msg.referer || sender.tab?.url || '')) return false

    upsertMediaRecord(tabId, {
      url: msg.url,
      filename: Shared.sanitizeFilename(msg.filename || Shared.extractFilename(msg.url)),
      category: msg.category || '',
      categoryHint: msg.categoryHint || '',
      platform: msg.platform || Shared.getPlatformStrategy(msg.url).name,
      contentType: msg.contentType || '',
      size: msg.size || '',
      sizeBytes: Shared.parseContentLength(msg.sizeBytes),
      referer: msg.referer || sender.tab?.url || '',
      frameId: sender.frameId,
      time: Date.now(),
      source: msg.source || 'content',
    })
    return false
  }

  if (msg.type === Shared.MESSAGE_TYPES.GET_MEDIA) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0]
      sendResponse({
        media: activeTab?.id ? listTabMedia(activeTab.id, activeTab.url || '') : [],
        tabId: activeTab?.id || null,
        tabUrl: activeTab?.url || '',
      })
    })
    return true
  }

  if (msg.type === Shared.MESSAGE_TYPES.GET_CAPTURE_SETTINGS) {
    sendResponse({ settings: captureSettings })
    return false
  }

  if (msg.type === Shared.MESSAGE_TYPES.SET_CAPTURE_SETTINGS) {
    captureSettings = Shared.normalizeSettings(msg.settings)
    chrome.storage.local.set({ captureSettings })
    filterByCaptureSettings()
    sendResponse({ ok: true, settings: captureSettings })
    return false
  }

  if (msg.type === Shared.MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
    const tabId = sender.tab?.id
    const tabUrl = sender.tab?.url || ''
    sendResponse({
      media: tabId ? listTabMedia(tabId, tabUrl) : [],
      tabId: tabId || null,
      tabUrl,
    })
    return false
  }

  if (msg.type === Shared.MESSAGE_TYPES.CLEAR_MEDIA) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) clearTabMedia(tabId)
      sendResponse({ ok: true })
    })
    return true
  }

  if (msg.type === Shared.MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB) {
    const tabId = sender.tab?.id
    if (tabId) clearTabMedia(tabId)
    sendResponse({ ok: true })
    return false
  }

  if (msg.type === Shared.MESSAGE_TYPES.DOWNLOAD) {
    handleDownloadRequest(msg, sender, sendResponse)
    return true
  }

  if (msg.type === Shared.MESSAGE_TYPES.GET_STREAM_CONTEXT) {
    const tabId = msg.tabId || sender.tab?.id
    if (!tabId) {
      sendResponse({ ok: false, error: '分析流媒体时未找到目标标签页' })
      return false
    }

    const record = decorateMediaRecord({
      url: msg.url,
      filename: msg.filename || Shared.extractFilename(msg.url),
      category: msg.category,
      categoryHint: msg.categoryHint,
      contentType: msg.contentType || '',
      frameId: Number.isInteger(msg.frameId) ? msg.frameId : sender.frameId,
      referer: msg.referer || '',
      time: Date.now(),
    })

    getStreamContext(record, tabId, !!msg.force)
      .then((context) => {
        sendResponse({ ok: true, context })
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message })
      })
    return true
  }

  return false
})
