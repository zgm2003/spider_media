/**
 * 媒体嗅探器 - 后台服务
 * 负责按标签页维护资源状态、执行下载、分析流媒体索引并向界面推送更新。
 */

importScripts('shared.js')

const Shared = globalThis.MediaSnifferShared
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
const STREAM_CACHE_TTL_MS = 5 * 60 * 1000
const STREAM_CACHE_LIMIT = 120
const REQUEST_CONTEXT_TTL_MS = 2 * 60 * 1000
const REQUEST_CONTEXT_LIMIT = 2000

const STATUS_RANK = {
  failed: -1,
  discovered: 0,
  analyzed: 1,
  exported: 2,
  downloaded: 3,
}

const mediaByTab = new Map()
const requestContextById = new Map()
const streamContextCache = new Map()
let captureSettings = { ...Shared.DEFAULT_CAPTURE_SETTINGS }
let sessionSaveTimer = null

chrome.storage.local.get(['captureSettings'], (data) => {
  captureSettings = Shared.normalizeSettings(data.captureSettings)
})

function scheduleSessionSave() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
  sessionSaveTimer = setTimeout(() => {
    const data = {}
    for (const [tabId, state] of mediaByTab.entries()) {
      const records = Array.from(state.recordsByKey.values())
      if (records.length) data[tabId] = records
    }
    chrome.storage.session?.set({ mediaByTab: data }).catch(() => {})
  }, 2000)
}

function restoreSession() {
  if (!chrome.storage.session) return
  chrome.storage.session.get(['mediaByTab'], (result) => {
    if (chrome.runtime.lastError || !result?.mediaByTab) return
    for (const [tabIdStr, records] of Object.entries(result.mediaByTab)) {
      const tabId = Number(tabIdStr)
      if (!Number.isFinite(tabId) || tabId < 0) continue
      const state = getTabState(tabId)
      for (const record of records) {
        const key = record.key || Shared.buildMediaKey(record.url, record.referer || '', record.frameId)
        state.recordsByKey.set(key, record)
      }
      updateBadge(tabId)
    }
  })
}

function getTabState(tabId) {
  if (!mediaByTab.has(tabId)) {
    mediaByTab.set(tabId, { recordsByKey: new Map() })
  }
  return mediaByTab.get(tabId)
}

function listTabMedia(tabId, fallbackReferer) {
  const records = Array.from(mediaByTab.get(tabId)?.recordsByKey.values() || [])
  return records.map((item) => ({
    ...item,
    referer: item.referer || fallbackReferer || '',
    refererOrigin: item.refererOrigin || Shared.getOrigin(item.referer || fallbackReferer || '', item.url || ''),
  }))
}

function categoryScore(category) {
  return category === 'other' ? 0 : 1
}

function statusRank(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, status) ? STATUS_RANK[status] : 0
}

function selectProgressStatus(currentStatus, nextStatus) {
  const current = currentStatus || 'discovered'
  const next = nextStatus || current

  if (next === 'failed') {
    return current === 'downloaded' ? current : next
  }

  if (current === 'failed') return next
  return statusRank(next) >= statusRank(current) ? next : current
}

function uniqueStringList(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)))
}

function normalizeHeaderMap(raw) {
  const result = {}
  const entries = Array.isArray(raw)
    ? raw.map((item) => [item?.name, item?.value])
    : Object.entries(raw || {})

  for (const [name, value] of entries) {
    const key = String(name || '').trim().toLowerCase()
    if (!key) continue
    const sensitive = key === 'cookie' || key === 'authorization' || key === 'proxy-authorization'
    result[key] = sensitive ? '[redacted]' : String(value || '')
  }

  return result
}

function decorateMediaRecord(record) {
  const category = Shared.normalizeCategory(record)
  const requestHeaders = normalizeHeaderMap(record.requestHeaders)
  const responseHeaders = normalizeHeaderMap(record.responseHeaders)
  const sourceList = uniqueStringList([...(record.sourceList || []), record.source])
  const referer = record.referer || ''
  const key = record.key || Shared.buildMediaKey(record.url, referer, record.frameId)

  return {
    ...record,
    key,
    category,
    finalUrl: record.finalUrl || record.url || '',
    filename: Shared.sanitizeFilename(record.filename || Shared.extractFilename(record.url)),
    requestHeaders,
    responseHeaders,
    referer,
    refererOrigin: record.refererOrigin || Shared.getOrigin(referer, record.url || ''),
    source: record.source || sourceList[0] || 'unknown',
    sourceList,
    method: record.method || '',
    initiator: record.initiator || '',
    fromCache: !!record.fromCache,
    status: record.status || 'discovered',
    hasCookieHeader:
      typeof record.hasCookieHeader === 'boolean'
        ? record.hasCookieHeader
        : Object.prototype.hasOwnProperty.call(requestHeaders, 'cookie'),
    hasAuthorizationHeader:
      typeof record.hasAuthorizationHeader === 'boolean'
        ? record.hasAuthorizationHeader
        : Object.prototype.hasOwnProperty.call(requestHeaders, 'authorization') ||
          Object.prototype.hasOwnProperty.call(requestHeaders, 'proxy-authorization'),
    lastError: record.lastError || '',
    biliMeta: record.biliMeta || '',
    downloadMode: Shared.getDownloadMode({ ...record, category }),
    downloadNotice: Shared.getDownloadNotice({ ...record, category }),
  }
}

function mergeMediaRecord(oldItem, newItem) {
  const oldCategory = oldItem.category || 'other'
  const newCategory = newItem.category || 'other'
  const preferNewCategory = categoryScore(newCategory) > categoryScore(oldCategory)
  const mergedRequestHeaders = { ...(oldItem.requestHeaders || {}), ...(newItem.requestHeaders || {}) }
  const mergedResponseHeaders = { ...(oldItem.responseHeaders || {}), ...(newItem.responseHeaders || {}) }

  return decorateMediaRecord({
    ...oldItem,
    ...newItem,
    id: oldItem.id || newItem.id,
    key: oldItem.key || newItem.key,
    category: preferNewCategory ? newCategory : oldCategory,
    categoryHint: newItem.categoryHint || oldItem.categoryHint || '',
    contentType: newItem.contentType || oldItem.contentType || '',
    size: newItem.size || oldItem.size || '',
    sizeBytes: newItem.sizeBytes || oldItem.sizeBytes || 0,
    referer: newItem.referer || oldItem.referer || '',
    refererOrigin: newItem.refererOrigin || oldItem.refererOrigin || '',
    finalUrl: newItem.finalUrl || oldItem.finalUrl || newItem.url || oldItem.url || '',
    filename: newItem.filename || oldItem.filename || 'media',
    frameId: Number.isInteger(newItem.frameId) ? newItem.frameId : oldItem.frameId,
    platform: newItem.platform || oldItem.platform || 'generic',
    source: newItem.source || oldItem.source || 'unknown',
    sourceList: uniqueStringList([...(oldItem.sourceList || []), ...(newItem.sourceList || []), oldItem.source, newItem.source]),
    method: newItem.method || oldItem.method || '',
    initiator: newItem.initiator || oldItem.initiator || '',
    fromCache: newItem.fromCache || oldItem.fromCache || false,
    requestHeaders: mergedRequestHeaders,
    responseHeaders: mergedResponseHeaders,
    hasCookieHeader: typeof newItem.hasCookieHeader === 'boolean' ? newItem.hasCookieHeader : !!oldItem.hasCookieHeader,
    hasAuthorizationHeader: typeof newItem.hasAuthorizationHeader === 'boolean' ? newItem.hasAuthorizationHeader : !!oldItem.hasAuthorizationHeader,
    status: selectProgressStatus(oldItem.status, newItem.status),
    lastError: newItem.lastError || oldItem.lastError || '',
    time: newItem.time || oldItem.time || Date.now(),
  })
}

function trimTabState(state) {
  while (state.recordsByKey.size > Shared.MAX_MEDIA_PER_TAB) {
    const firstKey = state.recordsByKey.keys().next().value
    state.recordsByKey.delete(firstKey)
  }
}

function cleanupRequestContexts() {
  const now = Date.now()
  for (const [requestId, entry] of requestContextById.entries()) {
    if (!entry || now - entry.createdAt > REQUEST_CONTEXT_TTL_MS) {
      requestContextById.delete(requestId)
    }
  }

  while (requestContextById.size > REQUEST_CONTEXT_LIMIT) {
    const firstKey = requestContextById.keys().next().value
    requestContextById.delete(firstKey)
  }
}

function storeRequestContext(requestId, context) {
  cleanupRequestContexts()
  requestContextById.set(requestId, {
    ...context,
    createdAt: Date.now(),
  })
  cleanupRequestContexts()
}

function takeRequestContext(requestId) {
  const entry = requestContextById.get(requestId) || null
  requestContextById.delete(requestId)
  return entry
}

function ignoreLastError() {
  void chrome.runtime.lastError
}

function updateBadge(tabId) {
  const count = mediaByTab.get(tabId)?.recordsByKey.size || 0
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
      count: mediaByTab.get(tabId)?.recordsByKey.size || 0,
    },
    ignoreLastError
  )

  chrome.runtime.sendMessage(
    {
      type: Shared.MESSAGE_TYPES.MEDIA_UPDATED,
      tabId,
      count: mediaByTab.get(tabId)?.recordsByKey.size || 0,
    },
    ignoreLastError
  )
}

function upsertMediaRecord(tabId, nextItem) {
  const state = getTabState(tabId)
  const key = nextItem.key || Shared.buildMediaKey(nextItem.url, nextItem.referer || '', nextItem.frameId)
  const existing = state.recordsByKey.get(key)
  const normalized = decorateMediaRecord({
    ...nextItem,
    key,
    id: existing?.id || nextItem.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  })

  if (!Shared.isCategoryEnabled(captureSettings, normalized.category)) return
  if (!existing && normalized.source === 'webRequest' && !Shared.isLikelyUsefulResource(normalized)) return

  state.recordsByKey.set(key, existing ? mergeMediaRecord(existing, normalized) : normalized)
  trimTabState(state)
  notifyMediaUpdated(tabId)
  scheduleSessionSave()
}

function patchMediaRecord(tabId, recordKey, patch) {
  const state = mediaByTab.get(tabId)
  if (!state || !recordKey || !state.recordsByKey.has(recordKey)) return

  const existing = state.recordsByKey.get(recordKey)
  const merged = mergeMediaRecord(existing, {
    ...existing,
    ...patch,
    id: existing.id,
    key: existing.key,
    status: selectProgressStatus(existing.status, patch.status || existing.status),
  })
  state.recordsByKey.set(recordKey, merged)
  notifyMediaUpdated(tabId)
  scheduleSessionSave()
}

function filterByCaptureSettings() {
  for (const [tabId, state] of mediaByTab.entries()) {
    for (const [key, item] of state.recordsByKey.entries()) {
      if (!Shared.isCategoryEnabled(captureSettings, item.category || 'other')) {
        state.recordsByKey.delete(key)
      }
    }
    notifyMediaUpdated(tabId)
  }
}

function clearTabMedia(tabId) {
  if (!mediaByTab.has(tabId)) return
  mediaByTab.get(tabId).recordsByKey.clear()
  notifyMediaUpdated(tabId)
  scheduleSessionSave()
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
  let encryptionMethod = ''
  let targetDuration = 0
  let playlistType = ''
  let hasEndList = false
  let firstVariantUrl = ''
  let firstSegmentUrl = ''
  let totalDurationSeconds = 0
  let waitingVariantAttrs = null

  const variants = []
  const mediaTracks = []
  const resolutions = []
  const bandwidths = []

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA')) {
      const attrs = parseAttributeList(line)
      mediaTracks.push({
        type: String(attrs.type || '').toLowerCase(),
        groupId: attrs['group-id'] || '',
        name: attrs.name || '',
        language: attrs.language || '',
        default: attrs.default || '',
        autoselect: attrs.autoselect || '',
        uri: attrs.uri ? Shared.toAbsoluteUrl(attrs.uri, manifestUrl) : '',
        instreamId: attrs['instream-id'] || '',
      })
      continue
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      variantCount += 1
      waitingVariantAttrs = parseAttributeList(line)
      if (waitingVariantAttrs.resolution) resolutions.push(waitingVariantAttrs.resolution)
      if (waitingVariantAttrs.bandwidth) {
        const numericBandwidth = parseInt(waitingVariantAttrs.bandwidth, 10)
        if (Number.isFinite(numericBandwidth)) bandwidths.push(numericBandwidth)
      }
      continue
    }

    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      variantCount += 1
      const attrs = parseAttributeList(line)
      const absoluteUrl = attrs.uri ? Shared.toAbsoluteUrl(attrs.uri, manifestUrl) : ''
      variants.push({
        type: 'iframe',
        url: absoluteUrl,
        resolution: attrs.resolution || '',
        bandwidth: parseInt(attrs.bandwidth || '0', 10) || 0,
        codecs: attrs.codecs || '',
        audioGroup: attrs.audio || '',
        subtitlesGroup: attrs.subtitles || '',
      })
      if (absoluteUrl && !firstVariantUrl) firstVariantUrl = absoluteUrl
      continue
    }

    if (line.startsWith('#EXTINF:')) {
      totalDurationSeconds += parseFloat(line.split(':')[1]?.split(',')[0] || '0') || 0
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributeList(line)
      const method = String(attrs.method || '').toUpperCase()
      if (method && method !== 'NONE') {
        encrypted = true
        if (!encryptionMethod) encryptionMethod = method
      }
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseInt(line.split(':')[1] || '0', 10) || 0
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = (line.split(':')[1] || '').trim()
    if (line.startsWith('#EXT-X-ENDLIST')) hasEndList = true

    if (line.startsWith('#')) continue

    const absoluteUrl = Shared.toAbsoluteUrl(line, manifestUrl)
    if (waitingVariantAttrs) {
      if (!firstVariantUrl) firstVariantUrl = absoluteUrl
      variants.push({
        type: 'variant',
        url: absoluteUrl,
        resolution: waitingVariantAttrs.resolution || '',
        bandwidth: parseInt(waitingVariantAttrs.bandwidth || '0', 10) || 0,
        codecs: waitingVariantAttrs.codecs || '',
        audioGroup: waitingVariantAttrs.audio || '',
        subtitlesGroup: waitingVariantAttrs.subtitles || '',
        frameRate: waitingVariantAttrs['frame-rate'] || '',
      })
      waitingVariantAttrs = null
      continue
    }

    segmentCount += 1
    if (!firstSegmentUrl) firstSegmentUrl = absoluteUrl
  }

  const manifestType = variantCount > 0 ? 'master' : 'media'
  const isLive = manifestType === 'media' ? !hasEndList && String(playlistType).toUpperCase() !== 'VOD' : false
  const durationLabel = totalDurationSeconds ? formatSeconds(totalDurationSeconds) : ''
  const bandwidthSummary = bandwidths.length
    ? `${Math.round(Math.min(...bandwidths) / 1000)}-${Math.round(Math.max(...bandwidths) / 1000)} kbps`
    : ''

  const details = []
  if (targetDuration) details.push(`目标分片时长 ${targetDuration}s`)
  if (resolutions.length) details.push(`分辨率 ${resolutions.slice(0, 3).join(', ')}`)
  if (bandwidthSummary) details.push(`码率 ${bandwidthSummary}`)
  if (durationLabel) details.push(`总时长约 ${durationLabel}`)
  if (encryptionMethod) details.push(`加密方式 ${encryptionMethod}`)
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
    totalDurationSeconds: Math.round(totalDurationSeconds),
    durationLabel,
    encryptionMethod,
    variants,
    mediaTracks,
    firstVariantUrl,
    firstSegmentUrl,
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

function parseXmlAttributes(fragment) {
  const attrs = {}
  const re = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g
  let match = re.exec(String(fragment || ''))
  while (match) {
    attrs[String(match[1] || '').toLowerCase()] = match[2] || ''
    match = re.exec(String(fragment || ''))
  }
  return attrs
}

function parseDashManifest(text, manifestUrl) {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const mpdMatch = source.match(/<MPD\b([^>]*)>/i)
  if (!mpdMatch) throw new Error('无效的 DASH 索引文件')

  const mpdAttrs = parseXmlAttributes(mpdMatch[1] || '')
  const type = mpdAttrs.type || 'static'
  const durationRaw = mpdAttrs.mediapresentationduration || ''
  const segmentTemplateCount = (source.match(/<SegmentTemplate\b/gi) || []).length
  const segmentTimelineEntryCount = (source.match(/<S\b/gi) || []).length
  const encrypted = /<ContentProtection\b/i.test(source)
  const baseUrls = Array.from(source.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/gi)).map((match) => {
    return Shared.toAbsoluteUrl(match[1]?.trim() || '', manifestUrl)
  })
  const firstBaseUrl = baseUrls[0] || ''
  const durationSeconds = parseIsoDurationToSeconds(durationRaw)
  const isLive = type.toLowerCase() === 'dynamic'
  const durationLabel = durationSeconds ? formatSeconds(durationSeconds) : ''

  const adaptationSets = Array.from(source.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)).map(
    (match, index) => {
      const attrs = parseXmlAttributes(match[1] || '')
      const body = match[2] || ''
      const mimeType = attrs.mimetype || ''
      const rawType = String(attrs.contenttype || '').toLowerCase()
      const inferredType = rawType || (
        /^video\//i.test(mimeType) ? 'video' :
        /^audio\//i.test(mimeType) ? 'audio' :
        /(text|subtitle|ttml|vtt)/i.test(mimeType) ? 'subtitle' :
        'unknown'
      )
      const representations = Array.from(body.matchAll(/<Representation\b([^>]*)/gi)).map((repMatch, repIndex) => {
        const repAttrs = parseXmlAttributes(repMatch[1] || '')
        return {
          id: repAttrs.id || `rep-${index + 1}-${repIndex + 1}`,
          bandwidth: parseInt(repAttrs.bandwidth || '0', 10) || 0,
          codecs: repAttrs.codecs || '',
          width: parseInt(repAttrs.width || '0', 10) || 0,
          height: parseInt(repAttrs.height || '0', 10) || 0,
          mimeType: repAttrs.mimetype || mimeType,
        }
      })

      return {
        id: attrs.id || `as-${index + 1}`,
        type: inferredType,
        mimeType,
        language: attrs.lang || attrs.language || '',
        segmentAlignment: attrs.segmentalignment || '',
        representations,
      }
    }
  )

  const adaptationSetCount = adaptationSets.length
  const representationCount = adaptationSets.reduce((sum, item) => sum + item.representations.length, 0)

  const details = []
  if (adaptationSetCount) details.push(`${adaptationSetCount} 个 AdaptationSet`)
  if (segmentTemplateCount) details.push(`${segmentTemplateCount} 个 SegmentTemplate 节点`)
  if (segmentTimelineEntryCount) details.push(`${segmentTimelineEntryCount} 条时间线条目`)
  if (durationLabel) details.push(`时长 ${durationLabel}`)
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
    durationLabel,
    baseUrls,
    adaptationSets,
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

function escapePowerShellArgument(value) {
  return String(value || '')
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
}

function buildStreamOutputFilename(record) {
  return Shared.replaceFileExtension(record.filename || Shared.extractFilename(record.url), 'mp4')
}

function buildReplayHeaders(record) {
  const headers = []
  if (record.referer) headers.push({ name: 'Referer', value: record.referer })

  const origin = Shared.getOrigin(record.referer || record.url, record.url)
  if (origin) headers.push({ name: 'Origin', value: origin })

  return headers
}

function buildFfmpegCommand(record) {
  const parts = ['ffmpeg']
  parts.push(`-user_agent "${escapePowerShellArgument(DEFAULT_USER_AGENT)}"`)

  if (record.referer) {
    parts.push(`-referer "${escapePowerShellArgument(record.referer)}"`)
  }

  const headerLines = buildReplayHeaders(record)
    .filter((header) => header.name !== 'Referer')
    .map((header) => `${header.name}: ${header.value}`)

  if (headerLines.length) {
    parts.push(`-headers "${escapePowerShellArgument(headerLines.join('`r`n'))}"`)
  }

  parts.push(`-i "${escapePowerShellArgument(record.url)}"`)
  parts.push('-c copy')
  parts.push(`"${escapePowerShellArgument(buildStreamOutputFilename(record))}"`)
  return parts.join(' ')
}

function buildYtDlpCommand(record) {
  const parts = ['yt-dlp']
  parts.push(`--user-agent "${escapePowerShellArgument(DEFAULT_USER_AGENT)}"`)

  if (record.referer) {
    parts.push(`--referer "${escapePowerShellArgument(record.referer)}"`)
  }

  for (const header of buildReplayHeaders(record)) {
    if (header.name === 'Referer') continue
    parts.push(`--add-header "${escapePowerShellArgument(`${header.name}: ${header.value}`)}"`)
  }

  parts.push(`-o "${escapePowerShellArgument(buildStreamOutputFilename(record))}"`)
  parts.push(`"${escapePowerShellArgument(record.url)}"`)
  return parts.join(' ')
}

function buildCurlCommand(record) {
  const parts = ['curl.exe', '-L']
  parts.push(`-A "${escapePowerShellArgument(DEFAULT_USER_AGENT)}"`)

  if (record.referer) {
    parts.push(`-e "${escapePowerShellArgument(record.referer)}"`)
  }

  for (const header of buildReplayHeaders(record)) {
    if (header.name === 'Referer') continue
    parts.push(`-H "${escapePowerShellArgument(`${header.name}: ${header.value}`)}"`)
  }

  parts.push(`-o "${escapePowerShellArgument(record.filename || Shared.extractFilename(record.url))}"`)
  parts.push(`"${escapePowerShellArgument(record.url)}"`)
  return parts.join(' ')
}

function buildExportTaskPayload(record, context) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    resource: {
      id: record.id || '',
      key: record.key || Shared.buildMediaKey(record.url, record.referer || '', record.frameId),
      status: record.status || 'discovered',
      category: record.category || Shared.normalizeCategory(record),
      filename: record.filename || Shared.extractFilename(record.url),
      url: record.url,
      finalUrl: context?.resolvedUrl || record.finalUrl || record.url,
      contentType: record.contentType || '',
      sizeBytes: Shared.parseContentLength(record.sizeBytes),
      size: record.size || '',
      referer: record.referer || '',
      refererOrigin: record.refererOrigin || Shared.getOrigin(record.referer || '', record.url || ''),
      frameId: Number.isInteger(record.frameId) ? record.frameId : null,
      method: record.method || '',
      initiator: record.initiator || '',
      fromCache: !!record.fromCache,
      sourceList: record.sourceList || [],
      requestHeaders: record.requestHeaders || {},
      responseHeaders: record.responseHeaders || {},
      cookieState: record.hasCookieHeader ? 'present-redacted' : 'not-observed',
      authorizationState: record.hasAuthorizationHeader ? 'present-redacted' : 'not-observed',
    },
    stream: context
      ? {
          kind: context.kind,
          summary: context.summary,
          resolvedUrl: context.resolvedUrl || record.url,
          analyzedAt: context.analyzedAt || null,
          analysis: context.analysis || null,
          commands: {
            ffmpeg: buildFfmpegCommand(record),
            ytDlp: buildYtDlpCommand(record),
            curl: buildCurlCommand(record),
          },
        }
      : null,
  }
}

function attachStreamExports(baseContext, record) {
  const exports = {
    commands: {
      ffmpeg: buildFfmpegCommand(record),
      ytDlp: buildYtDlpCommand(record),
      curl: buildCurlCommand(record),
    },
    task: buildExportTaskPayload(record, baseContext),
  }

  return {
    ...baseContext,
    exports,
    command: exports.commands.ffmpeg,
  }
}

function getStreamCacheKey(record) {
  return record.key || Shared.buildMediaKey(record.url, record.referer || '', record.frameId)
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
      return attachStreamExports(cached.context, {
        ...record,
        finalUrl: cached.context.resolvedUrl || record.finalUrl || record.url,
      })
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
    resolvedUrl: manifestUrl,
    analyzedAt: Date.now(),
  }

  streamContextCache.set(cacheKey, {
    updatedAt: Date.now(),
    context,
  })

  cleanupStreamContextCache()
  return attachStreamExports(context, {
    ...record,
    finalUrl: manifestUrl,
  })
}

async function handleDownloadRequest(msg, sender, sendResponse) {
  const tabId = msg.tabId || sender.tab?.id || (await getActiveTabId())
  if (!tabId) {
    sendResponse({ ok: false, error: '未找到目标标签页' })
    return
  }

  const record = decorateMediaRecord({
    key: msg.key,
    url: msg.url,
    filename: msg.filename || Shared.extractFilename(msg.url),
    category: msg.category,
    categoryHint: msg.categoryHint,
    contentType: msg.contentType || '',
    sizeBytes: Shared.parseContentLength(msg.sizeBytes),
    frameId: Number.isInteger(msg.frameId) ? msg.frameId : sender.frameId,
    referer: msg.referer || '',
    requestHeaders: msg.requestHeaders || {},
    responseHeaders: msg.responseHeaders || {},
    time: Date.now(),
  })

  const filename = Shared.buildDownloadPath(record.filename, record.category)
  const mode = record.downloadMode
  const warning = record.downloadNotice

  if (mode === 'manifest' || mode === 'segment' || mode === 'direct') {
    const directResp = await downloadFile({ url: record.url, filename })
    patchMediaRecord(tabId, record.key, {
      status: directResp.ok ? 'downloaded' : 'failed',
      lastError: directResp.ok ? '' : directResp.error || '',
    })
    sendResponse({ ...directResp, warning })
    return
  }

  try {
    const dataUrl = await resolveMediaDataUrl(record, tabId)
    const result = await downloadFile({ url: dataUrl, filename })
    patchMediaRecord(tabId, record.key, {
      status: result.ok ? 'downloaded' : 'failed',
      lastError: result.ok ? '' : result.error || '',
    })
    sendResponse({ ...result, warning })
  } catch (err) {
    const fallbackResp = await downloadFile({ url: record.url, filename })
    if (fallbackResp.ok) {
      patchMediaRecord(tabId, record.key, {
        status: 'downloaded',
        lastError: '',
      })
      sendResponse({ ...fallbackResp, warning })
      return
    }
    patchMediaRecord(tabId, record.key, {
      status: 'failed',
      lastError: `${err.message}; ${fallbackResp.error || ''}`.trim(),
    })
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
    const requestHeaders = normalizeHeaderMap(details.requestHeaders || [])
    storeRequestContext(details.requestId, {
      referer: requestHeaders.referer || '',
      requestHeaders,
      hasCookieHeader: Object.prototype.hasOwnProperty.call(requestHeaders, 'cookie'),
      hasAuthorizationHeader:
        Object.prototype.hasOwnProperty.call(requestHeaders, 'authorization') ||
        Object.prototype.hasOwnProperty.call(requestHeaders, 'proxy-authorization'),
    })
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
)

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return
    cleanupRequestContexts()

    const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value || ''
    const requestContext = takeRequestContext(details.requestId)
    if (!Shared.shouldCaptureResource(details.url, contentType)) {
      return
    }

    const category = Shared.inferCategory(details.url, contentType)
    if (!Shared.isCategoryEnabled(captureSettings, category)) {
      return
    }

    const contentLength = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-length')?.value || ''
    const sizeBytes = Shared.parseContentLength(contentLength)
    upsertMediaRecord(details.tabId, {
      url: details.url,
      finalUrl: details.url,
      filename: Shared.extractFilename(details.url),
      category,
      platform: Shared.getPlatformStrategy(details.url).name,
      contentType,
      size: Shared.formatSize(contentLength),
      sizeBytes,
      referer: requestContext?.referer || '',
      requestHeaders: requestContext?.requestHeaders || {},
      responseHeaders: normalizeHeaderMap(details.responseHeaders || []),
      hasCookieHeader: requestContext?.hasCookieHeader || false,
      hasAuthorizationHeader: requestContext?.hasAuthorizationHeader || false,
      frameId: details.frameId,
      method: details.method || '',
      initiator: details.initiator || '',
      fromCache: !!details.fromCache,
      status: 'discovered',
      time: Date.now(),
      source: 'webRequest',
    })
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

chrome.webRequest.onErrorOccurred.addListener((details) => {
  requestContextById.delete(details.requestId)
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
      key: msg.key,
      finalUrl: msg.finalUrl || msg.url,
      filename: Shared.sanitizeFilename(msg.filename || Shared.extractFilename(msg.url)),
      category: msg.category || '',
      categoryHint: msg.categoryHint || '',
      platform: msg.platform || Shared.getPlatformStrategy(msg.url).name,
      contentType: msg.contentType || '',
      size: msg.size || '',
      sizeBytes: Shared.parseContentLength(msg.sizeBytes),
      referer: msg.referer || sender.tab?.url || '',
      frameId: sender.frameId,
      method: msg.method || '',
      initiator: msg.initiator || '',
      requestHeaders: msg.requestHeaders || {},
      responseHeaders: msg.responseHeaders || {},
      status: msg.status || 'discovered',
      biliMeta: msg.biliMeta || '',
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

  if (msg.type === Shared.MESSAGE_TYPES.SET_MEDIA_STATUS) {
    const tabId = msg.tabId || sender.tab?.id
    if (!tabId || !msg.key) {
      sendResponse({ ok: false, error: '更新资源状态时缺少 tabId 或 key' })
      return false
    }

    patchMediaRecord(tabId, msg.key, {
      status: msg.status || 'discovered',
      lastError: msg.lastError || '',
    })
    sendResponse({ ok: true })
    return false
  }

  if (msg.type === Shared.MESSAGE_TYPES.GET_STREAM_CONTEXT) {
    const tabId = msg.tabId || sender.tab?.id
    if (!tabId) {
      sendResponse({ ok: false, error: '分析流媒体时未找到目标标签页' })
      return false
    }

    const record = decorateMediaRecord({
      key: msg.key,
      url: msg.url,
      filename: msg.filename || Shared.extractFilename(msg.url),
      category: msg.category,
      categoryHint: msg.categoryHint,
      contentType: msg.contentType || '',
      frameId: Number.isInteger(msg.frameId) ? msg.frameId : sender.frameId,
      referer: msg.referer || '',
      requestHeaders: msg.requestHeaders || {},
      responseHeaders: msg.responseHeaders || {},
      status: msg.status || 'discovered',
      time: Date.now(),
    })

    getStreamContext(record, tabId, !!msg.force)
      .then((context) => {
        patchMediaRecord(tabId, record.key, {
          status: 'analyzed',
          finalUrl: context.resolvedUrl || record.url,
          lastError: '',
        })
        sendResponse({ ok: true, context })
      })
      .catch((err) => {
        patchMediaRecord(tabId, record.key, {
          status: 'failed',
          lastError: err.message,
        })
        sendResponse({ ok: false, error: err.message })
      })
    return true
  }

  return false
})

restoreSession()
