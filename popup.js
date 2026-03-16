/**
 * 媒体嗅探器 - 弹窗控制器
 * 负责弹窗内的资源展示、下载、流媒体分析和设置交互。
 */

const Shared = window.MediaSnifferShared

let currentMedia = []
let activeTab = 'video'
let normalizedMedia = []
let captureSettings = { ...Shared.DEFAULT_CAPTURE_SETTINGS }
let currentTabId = null

const streamContextByKey = new Map()
const pendingStreamKeys = new Set()
const expandedKeys = new Set()
let sortMode = 'time'

const mediaListEl = document.getElementById('mediaList')
const emptyTip = document.getElementById('emptyTip')
const countBadge = document.getElementById('countBadge')
const pageUrlEl = document.getElementById('pageUrl')
const tabsEl = document.getElementById('tabs')
const previewMaskEl = document.getElementById('imgPreviewMask')
const previewImgEl = document.getElementById('imgPreview')
const setVideoEl = document.getElementById('setVideo')
const setImageEl = document.getElementById('setImage')
const setAudioEl = document.getElementById('setAudio')
const setOtherEl = document.getElementById('setOther')
const settingsPanelEl = document.getElementById('settingsPanel')
const btnSettingsEl = document.getElementById('btnSettings')
const statusNoteEl = document.getElementById('statusNote')
const sortSelectEl = document.getElementById('sortSelect')
const batchBarEl = document.getElementById('batchBar')
const batchLabelEl = document.getElementById('batchLabel')

const TAB_ORDER = ['video', 'image', 'audio', 'other']
const TAB_LABEL = {
  video: '视频',
  image: '图片',
  audio: '音频',
  other: '其他',
}

const STATUS_LABEL = {
  discovered: '已发现',
  analyzed: '已分析',
  exported: '已导出',
  downloaded: '已下载',
  failed: '失败',
}

function typeLabel(category) {
  if (category === 'video') return '<span class="tag video">视频</span>'
  if (category === 'audio') return '<span class="tag audio">音频</span>'
  if (category === 'image') return '<span class="tag image">图片</span>'
  return '<span class="tag other">其他</span>'
}

function streamLabel(item) {
  const mode = Shared.getDownloadMode(item)
  if (mode === 'manifest') return '<span class="tag stream">索引</span>'
  if (mode === 'segment') return '<span class="tag stream">分片</span>'
  return ''
}

function statusLabel(item) {
  const status = item.status || 'discovered'
  if (status === 'discovered') return ''
  const text = STATUS_LABEL[status] || status
  return `<span class="tag status ${Shared.escapeHtml(status)}">${Shared.escapeHtml(text)}</span>`
}

function platformLabel(item) {
  const name = item.platform || 'generic'
  if (name === 'generic') return ''
  return `<span class="platform-tag">${Shared.escapeHtml(name)}</span>`
}

function isManifestItem(item) {
  return Shared.getDownloadMode(item) === 'manifest'
}

function getItemKey(item) {
  return item.key || item.id || ''
}

function findMediaByKey(key) {
  return currentMedia.find((item) => getItemKey(item) === key) || null
}

function findMediaById(itemId) {
  return currentMedia.find((item) => item.id === itemId) || null
}

function applySettingInputs() {
  if (setVideoEl) setVideoEl.checked = !!captureSettings.video
  if (setImageEl) setImageEl.checked = !!captureSettings.image
  if (setAudioEl) setAudioEl.checked = !!captureSettings.audio
  if (setOtherEl) setOtherEl.checked = !!captureSettings.other
}

function setStatusNote(text, tone) {
  if (!statusNoteEl) return
  statusNoteEl.textContent = text || ''
  statusNoteEl.style.display = text ? 'block' : 'none'
  statusNoteEl.dataset.tone = tone || 'info'
}

function pruneStreamContextCache() {
  const validKeys = new Set(currentMedia.map((item) => getItemKey(item)))
  for (const key of Array.from(streamContextByKey.keys())) {
    if (!validKeys.has(key)) streamContextByKey.delete(key)
  }
  for (const key of Array.from(pendingStreamKeys)) {
    if (!validKeys.has(key)) pendingStreamKeys.delete(key)
  }
  for (const key of Array.from(expandedKeys)) {
    if (!validKeys.has(key)) expandedKeys.delete(key)
  }
}

function updateCaptureSettings(nextSettings) {
  captureSettings = { ...captureSettings, ...nextSettings }
  chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.SET_CAPTURE_SETTINGS, settings: captureSettings }, (resp) => {
    if (resp?.settings) captureSettings = resp.settings
    applySettingInputs()
    loadSniffData()
  })
}

function loadCaptureSettings() {
  chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.GET_CAPTURE_SETTINGS }, (resp) => {
    if (resp?.settings) captureSettings = resp.settings
    applySettingInputs()
  })
}

function renderTabs(counts) {
  tabsEl.innerHTML = TAB_ORDER.map((key) => {
    const activeClass = key === activeTab ? 'active' : ''
    const disabled = counts[key] ? '' : 'disabled'
    return `<button class="tab-btn ${activeClass}" data-cat="${key}" ${disabled}>${TAB_LABEL[key]} (${counts[key] || 0})</button>`
  }).join('')
}

function formatHeadersDisplay(headers) {
  if (!headers || typeof headers !== 'object') return ''
  const entries = Object.entries(headers).filter(([, v]) => v)
  if (!entries.length) return ''
  return entries.map(([k, v]) => `${Shared.escapeHtml(k)}: ${Shared.escapeHtml(v)}`).join('\n')
}

function parseBiliMeta(item) {
  if (!item.biliMeta) return null
  try { return JSON.parse(item.biliMeta) } catch (_) { return null }
}

function biliLabel(item) {
  const meta = parseBiliMeta(item)
  if (!meta) return ''
  if (meta.type === 'video') {
    const parts = [meta.qlabel || '', meta.width && meta.height ? `${meta.width}x${meta.height}` : '', meta.codecs || ''].filter(Boolean)
    return `<span class="platform-tag">${Shared.escapeHtml(parts.join(' '))}</span>`
  }
  if (meta.type === 'audio') {
    const parts = [meta.qlabel || '', meta.codecs || ''].filter(Boolean)
    return `<span class="platform-tag">${Shared.escapeHtml(parts.join(' '))}</span>`
  }
  return ''
}

function findBestBiliAudio() {
  let best = null
  let bestBw = -1
  for (const item of currentMedia) {
    const meta = parseBiliMeta(item)
    if (!meta || meta.type !== 'audio') continue
    const bw = meta.bandwidth || meta.quality || 0
    if (bw > bestBw) { bestBw = bw; best = item }
  }
  return best
}

function buildBiliMergeCommand(videoItem) {
  const audioItem = findBestBiliAudio()
  if (!audioItem) return ''
  const referer = videoItem.referer || 'https://www.bilibili.com'
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
  const meta = parseBiliMeta(videoItem)
  const qlabel = meta?.qlabel || 'video'
  const outName = `bilibili_${qlabel}.mp4`
  return `ffmpeg -user_agent "${ua}" -referer "${referer}" -i "${videoItem.url}" -i "${audioItem.url}" -c copy -movflags +faststart "${outName}"`
}

function getContextNoteHtml(item) {
  const notes = []
  const meta = parseBiliMeta(item)
  if (meta?.type === 'video') {
    notes.push('B站视频与音频分离，点击「合并命令」可生成包含视频+最佳音频的 ffmpeg 命令。')
  }
  if (meta?.type === 'audio') {
    notes.push('B站音频轨道，需与视频轨道合并使用。')
  }
  if (item.hasCookieHeader) {
    notes.push('请求中包含 Cookie，离站复现时可能需要手动添加。')
  }
  if (item.hasAuthorizationHeader) {
    notes.push('请求中包含鉴权头，离站复现时可能需要手动添加。')
  }
  if (!notes.length) return ''
  return notes.map((n) => `<div class="context-note">${Shared.escapeHtml(n)}</div>`).join('')
}

function getHlsAnalysisHtml(analysis) {
  if (!analysis || analysis.kind !== 'hls') return ''

  const sections = []

  if (analysis.variants && analysis.variants.length) {
    const rows = analysis.variants.map((v) => {
      const parts = [v.resolution || '', v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : '', v.codecs || ''].filter(Boolean)
      return `<div class="analysis-item">
        <div class="analysis-main">${Shared.escapeHtml(v.type === 'iframe' ? '[I-Frame]' : '')} ${Shared.escapeHtml(parts.join(' | ') || v.url || '未知')}</div>
        ${v.url ? `<div class="analysis-sub">${Shared.escapeHtml(v.url)}</div>` : ''}
      </div>`
    }).join('')
    sections.push(`<div class="analysis-card"><div class="analysis-title">变体 (${analysis.variants.length})</div>${rows}</div>`)
  }

  if (analysis.mediaTracks && analysis.mediaTracks.length) {
    const rows = analysis.mediaTracks.map((t) => {
      const parts = [t.type || '', t.name || '', t.language || '', t.groupId ? `group: ${t.groupId}` : ''].filter(Boolean)
      return `<div class="analysis-item">
        <div class="analysis-main">${Shared.escapeHtml(parts.join(' | '))}</div>
        ${t.uri ? `<div class="analysis-sub">${Shared.escapeHtml(t.uri)}</div>` : ''}
      </div>`
    }).join('')
    sections.push(`<div class="analysis-card"><div class="analysis-title">媒体轨道 (${analysis.mediaTracks.length})</div>${rows}</div>`)
  }

  const info = []
  if (analysis.encryptionMethod) info.push(`加密: ${analysis.encryptionMethod}`)
  if (analysis.totalDurationSeconds) info.push(`估算时长: ${analysis.durationLabel || analysis.totalDurationSeconds + 's'}`)
  if (analysis.targetDuration) info.push(`分片目标时长: ${analysis.targetDuration}s`)
  if (analysis.segmentCount) info.push(`分片数: ${analysis.segmentCount}`)
  if (analysis.playlistType) info.push(`类型: ${analysis.playlistType}`)

  if (info.length) {
    const rows = info.map((i) => `<div class="analysis-item"><div class="analysis-main">${Shared.escapeHtml(i)}</div></div>`).join('')
    sections.push(`<div class="analysis-card"><div class="analysis-title">基本信息</div>${rows}</div>`)
  }

  return sections.length ? `<div class="analysis-panel">${sections.join('')}</div>` : ''
}

function getDashAnalysisHtml(analysis) {
  if (!analysis || analysis.kind !== 'dash') return ''

  const sections = []

  if (analysis.adaptationSets && analysis.adaptationSets.length) {
    const cards = analysis.adaptationSets.map((as) => {
      const typeLabel = as.type === 'video' ? '视频' : as.type === 'audio' ? '音频' : as.type === 'subtitle' ? '字幕' : as.type || '未知'
      const langPart = as.language ? ` (${as.language})` : ''

      const repRows = (as.representations || []).map((r) => {
        const parts = []
        if (r.width && r.height) parts.push(`${r.width}x${r.height}`)
        if (r.bandwidth) parts.push(`${Math.round(r.bandwidth / 1000)} kbps`)
        if (r.codecs) parts.push(r.codecs)
        return `<div class="analysis-item"><div class="analysis-main">${Shared.escapeHtml(parts.join(' | ') || r.id || '未知')}</div></div>`
      }).join('')

      return `<div class="analysis-card">
        <div class="analysis-title">${Shared.escapeHtml(typeLabel)}${Shared.escapeHtml(langPart)} — ${as.representations?.length || 0} 个表示层</div>
        ${repRows || '<div class="analysis-empty">无表示层信息</div>'}
      </div>`
    }).join('')
    sections.push(cards)
  }

  const info = []
  if (analysis.durationLabel) info.push(`时长: ${analysis.durationLabel}`)
  if (analysis.encrypted) info.push('包含 DRM 内容保护')
  if (analysis.isLive) info.push('直播流')
  if (analysis.segmentTemplateCount) info.push(`SegmentTemplate: ${analysis.segmentTemplateCount}`)
  if (analysis.segmentTimelineEntryCount) info.push(`时间线条目: ${analysis.segmentTimelineEntryCount}`)

  if (info.length) {
    const rows = info.map((i) => `<div class="analysis-item"><div class="analysis-main">${Shared.escapeHtml(i)}</div></div>`).join('')
    sections.push(`<div class="analysis-card"><div class="analysis-title">基本信息</div>${rows}</div>`)
  }

  return sections.length ? `<div class="analysis-panel">${sections.join('')}</div>` : ''
}

function getContextSummaryHtml(item) {
  const key = getItemKey(item)
  const context = streamContextByKey.get(key)
  if (!context) return ''

  const analysis = context.analysis || {}
  const analysisHtml = analysis.kind === 'hls' ? getHlsAnalysisHtml(analysis) : getDashAnalysisHtml(analysis)

  const summaryLine = context.summary
    ? `<div class="stream-title">${Shared.escapeHtml(context.summary)}</div>`
    : '<div class="stream-title">流媒体分析已就绪</div>'

  const detailHtml = (context.details || [])
    .slice(0, 6)
    .map((detail) => `<div>${Shared.escapeHtml(detail)}</div>`)
    .join('')

  return `<div class="stream-summary">
    ${summaryLine}
    ${detailHtml}
  </div>
  ${analysisHtml}`
}

function getStreamToolsHtml(item) {
  if (!isManifestItem(item)) return ''

  const key = getItemKey(item)
  const isPending = pendingStreamKeys.has(key)
  const hasContext = streamContextByKey.has(key)
  const analyzeLabel = isPending ? '分析中...' : hasContext ? '刷新分析' : '分析'
  const disabled = isPending ? 'disabled' : ''

  const copyButtons = hasContext
    ? `<button class="btn-alt js-stream-action" data-action="copy-ffmpeg" data-key="${Shared.escapeHtml(key)}" ${disabled}>ffmpeg</button>
       <button class="btn-alt js-stream-action" data-action="copy-ytdlp" data-key="${Shared.escapeHtml(key)}" ${disabled}>yt-dlp</button>
       <button class="btn-alt js-stream-action" data-action="copy-curl" data-key="${Shared.escapeHtml(key)}" ${disabled}>curl</button>
       <button class="btn-alt js-stream-action" data-action="export-json" data-key="${Shared.escapeHtml(key)}" ${disabled}>导出 JSON</button>`
    : `<button class="btn-alt js-stream-action" data-action="copy-ffmpeg" data-key="${Shared.escapeHtml(key)}" ${disabled}>复制 ffmpeg</button>`

  return `<div class="stream-tools">
    <button class="btn-alt js-stream-action" data-action="analyze" data-key="${Shared.escapeHtml(key)}" ${disabled}>${analyzeLabel}</button>
    ${copyButtons}
  </div>`
}

function getDetailsPanelHtml(item) {
  const key = getItemKey(item)
  if (!expandedKeys.has(key)) return ''

  const fields = []

  fields.push({ label: '完整 URL', value: item.url || '', wide: true, mono: true })

  if (item.finalUrl && item.finalUrl !== item.url) {
    fields.push({ label: '最终地址', value: item.finalUrl, wide: true, mono: true })
  }

  const sourceList = item.sourceList && item.sourceList.length ? item.sourceList.join(', ') : item.source || 'unknown'
  fields.push({ label: '来源链路', value: sourceList })
  fields.push({ label: 'Referer', value: item.referer || '(无)' })

  if (item.refererOrigin) {
    fields.push({ label: 'Referer Origin', value: item.refererOrigin })
  }

  if (Number.isInteger(item.frameId)) {
    fields.push({ label: 'Frame ID', value: item.frameId === 0 ? '0 (主框架)' : String(item.frameId) })
  }

  if (item.method) {
    fields.push({ label: '请求方法', value: item.method })
  }

  if (item.initiator) {
    fields.push({ label: 'Initiator', value: item.initiator })
  }

  if (item.fromCache) {
    fields.push({ label: '缓存', value: '来自缓存' })
  }

  if (item.contentType) {
    fields.push({ label: 'Content-Type', value: item.contentType })
  }

  if (item.size) {
    fields.push({ label: '大小', value: item.size })
  }

  if (item.time) {
    fields.push({ label: '发现时间', value: new Date(item.time).toLocaleString() })
  }

  const reqHeaders = formatHeadersDisplay(item.requestHeaders)
  if (reqHeaders) {
    fields.push({ label: '请求头', value: reqHeaders, wide: true, mono: true })
  }

  const respHeaders = formatHeadersDisplay(item.responseHeaders)
  if (respHeaders) {
    fields.push({ label: '响应头', value: respHeaders, wide: true, mono: true })
  }

  const gridHtml = fields.map((f) => {
    const wideClass = f.wide ? ' wide' : ''
    const monoClass = f.mono ? ' mono' : ''
    return `<div class="detail-field${wideClass}">
      <div class="detail-label">${Shared.escapeHtml(f.label)}</div>
      <div class="detail-value${monoClass}">${Shared.escapeHtml(f.value)}</div>
    </div>`
  }).join('')

  const copyUrlBtn = `<button class="btn-alt js-detail-action" data-action="copy-url" data-key="${Shared.escapeHtml(key)}">复制 URL</button>`
  const copyRefererBtn = item.referer ? `<button class="btn-alt js-detail-action" data-action="copy-referer" data-key="${Shared.escapeHtml(key)}">复制 Referer</button>` : ''

  return `<div class="details-panel">
    <div class="detail-actions">
      ${copyUrlBtn}
      ${copyRefererBtn}
    </div>
    <div class="detail-grid">${gridHtml}</div>
  </div>`
}

function sortItems(list, mode) {
  const copy = list.slice()
  if (mode === 'size') return copy.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
  if (mode === 'name') return copy.sort((a, b) => (a.filename || '').localeCompare(b.filename || ''))
  if (mode === 'platform') return copy.sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || (b.time || 0) - (a.time || 0))
  return copy.sort((a, b) => (b.time || 0) - (a.time || 0))
}

function getVisibleList() {
  const filtered = normalizedMedia.filter((item) => item._category === activeTab)
  return sortItems(filtered, sortMode)
}

function updateBatchBar(list) {
  if (!batchBarEl || !batchLabelEl) return
  if (list.length < 2) {
    batchBarEl.style.display = 'none'
    return
  }
  batchBarEl.style.display = 'flex'
  batchLabelEl.textContent = `批量 (${list.length})：`
}

function renderActiveList() {
  const list = getVisibleList()

  if (!list.length) {
    mediaListEl.innerHTML = ''
    emptyTip.style.display = 'block'
    updateBatchBar([])
    return
  }

  emptyTip.style.display = 'none'
  updateBatchBar(list)

  mediaListEl.innerHTML = list.map((item) => {
    const key = getItemKey(item)
    const isExpanded = expandedKeys.has(key)
    const expandedClass = isExpanded ? ' expanded' : ''

    const previewHtml = item._category === 'image'
      ? `<img class="thumb js-thumb" data-url="${Shared.escapeHtml(item.url || '')}" src="${Shared.escapeHtml(item.url || '')}" alt="preview" />`
      : ''
    const meta = [
      item.size ? `<span>${Shared.escapeHtml(item.size)}</span>` : '',
      item.contentType ? `<span>${Shared.escapeHtml(item.contentType)}</span>` : '',
      item.source ? `<span>${Shared.escapeHtml(item.source)}</span>` : '',
      item.time ? `<span>${Shared.escapeHtml(new Date(item.time).toLocaleTimeString())}</span>` : '',
    ].filter(Boolean).join('')
    const note = item.downloadNotice ? `<div class="note">${Shared.escapeHtml(item.downloadNotice)}</div>` : ''

    const biliMergeBtn = parseBiliMeta(item)?.type === 'video'
      ? `<button class="btn-alt js-bili-merge" data-key="${Shared.escapeHtml(key)}">合并命令</button>`
      : ''

    return `<div class="media-item${expandedClass}" data-key="${Shared.escapeHtml(key)}">
      <div class="row">
        ${typeLabel(item._category)}
        ${streamLabel(item)}
        ${statusLabel(item)}
        ${platformLabel(item)}
        ${biliLabel(item)}
        ${previewHtml}
        <span class="filename" title="${Shared.escapeHtml(item.filename || 'media')}">${Shared.escapeHtml(item.filename || 'media')}</span>
        <div class="row-actions">
          ${biliMergeBtn}
          <button class="btn-alt js-expand" data-key="${Shared.escapeHtml(key)}">${isExpanded ? '收起' : '详情'}</button>
          <button class="btn-dl" data-id="${Shared.escapeHtml(item.id)}" data-key="${Shared.escapeHtml(key)}">下载</button>
        </div>
      </div>
      <div class="meta">${meta}</div>
      ${note}
      ${getContextNoteHtml(item)}
      ${getStreamToolsHtml(item)}
      ${getContextSummaryHtml(item)}
      ${getDetailsPanelHtml(item)}
    </div>`
  }).join('')
}

function loadSniffData() {
  chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.GET_MEDIA }, (resp) => {
    if (!resp) return

    currentMedia = resp.media || []
    currentTabId = resp.tabId || null
    pruneStreamContextCache()

    if (resp.tabUrl) {
      try {
        pageUrlEl.textContent = new URL(resp.tabUrl).hostname
        pageUrlEl.title = resp.tabUrl
      } catch (_) {
        pageUrlEl.textContent = '当前页面'
        pageUrlEl.title = ''
      }
    }

    countBadge.textContent = `${currentMedia.length} 个资源`

    if (!currentMedia.length) {
      normalizedMedia = []
      tabsEl.innerHTML = ''
      mediaListEl.innerHTML = ''
      emptyTip.style.display = 'block'
      return
    }

    emptyTip.style.display = 'none'
    normalizedMedia = currentMedia.map((item) => ({
      ...item,
      _category: Shared.normalizeCategory(item),
    }))

    const counts = { video: 0, image: 0, audio: 0, other: 0 }
    normalizedMedia.forEach((item) => {
      counts[item._category] += 1
    })

    if (!counts[activeTab]) {
      activeTab = TAB_ORDER.find((key) => counts[key] > 0) || 'video'
    }

    renderTabs(counts)
    renderActiveList()
  })
}

function downloadMedia(item, buttonEl) {
  if (!item || !buttonEl) return

  buttonEl.textContent = '下载中...'
  chrome.runtime.sendMessage(
    {
      type: Shared.MESSAGE_TYPES.DOWNLOAD,
      tabId: currentTabId,
      key: getItemKey(item),
      frameId: item.frameId,
      url: item.url,
      filename: item.filename,
      category: Shared.normalizeCategory(item),
      contentType: item.contentType,
      referer: item.referer,
      sizeBytes: item.sizeBytes,
      requestHeaders: item.requestHeaders || {},
      responseHeaders: item.responseHeaders || {},
    },
    (resp) => {
      if (resp?.warning) setStatusNote(resp.warning, 'warn')
      if (resp?.ok) {
        buttonEl.textContent = '完成'
      } else {
        buttonEl.textContent = '失败'
        if (resp?.error) {
          buttonEl.title = resp.error
          setStatusNote(resp.error, 'error')
        }
      }

      setTimeout(() => {
        buttonEl.textContent = '下载'
        buttonEl.title = ''
      }, 1500)
    }
  )
}

function requestStreamContext(item, forceRefresh) {
  const key = getItemKey(item)
  return new Promise((resolve) => {
    pendingStreamKeys.add(key)
    renderActiveList()

    chrome.runtime.sendMessage(
      {
        type: Shared.MESSAGE_TYPES.GET_STREAM_CONTEXT,
        tabId: currentTabId,
        key: key,
        frameId: item.frameId,
        url: item.url,
        filename: item.filename,
        category: item.category,
        categoryHint: item.categoryHint,
        contentType: item.contentType,
        referer: item.referer,
        requestHeaders: item.requestHeaders || {},
        responseHeaders: item.responseHeaders || {},
        status: item.status || 'discovered',
        force: !!forceRefresh,
      },
      (resp) => {
        pendingStreamKeys.delete(key)
        if (resp?.ok && resp.context) {
          streamContextByKey.set(key, resp.context)
          setStatusNote('流媒体索引分析完成。', 'success')
          renderActiveList()
          resolve(resp.context)
          return
        }

        setStatusNote(resp?.error || '流媒体分析失败。', 'error')
        renderActiveList()
        resolve(null)
      }
    )
  })
}

async function copyText(text) {
  if (!text) return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (_) {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'readonly')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  }
}

async function ensureStreamContext(item) {
  const key = getItemKey(item)
  let context = streamContextByKey.get(key)
  if (!context) {
    context = await requestStreamContext(item, false)
  }
  return context
}

async function handleStreamAction(key, action) {
  const item = findMediaByKey(key)
  if (!item || !isManifestItem(item)) return

  if (action === 'analyze') {
    await requestStreamContext(item, true)
    return
  }

  const context = await ensureStreamContext(item)
  if (!context) {
    setStatusNote('流媒体分析失败，无法生成命令。', 'error')
    return
  }

  const commands = context.exports?.commands || {}

  if (action === 'copy-ffmpeg' || action === 'copy-command') {
    const text = commands.ffmpeg || context.command || ''
    if (!text) {
      setStatusNote('无法生成 ffmpeg 命令。', 'error')
      return
    }
    const ok = await copyText(text)
    setStatusNote(ok ? 'ffmpeg 命令已复制到剪贴板。' : '复制失败。', ok ? 'success' : 'error')
    return
  }

  if (action === 'copy-ytdlp') {
    const text = commands.ytDlp || ''
    if (!text) {
      setStatusNote('无法生成 yt-dlp 命令。', 'error')
      return
    }
    const ok = await copyText(text)
    setStatusNote(ok ? 'yt-dlp 命令已复制到剪贴板。' : '复制失败。', ok ? 'success' : 'error')
    return
  }

  if (action === 'copy-curl') {
    const text = commands.curl || ''
    if (!text) {
      setStatusNote('无法生成 curl 命令。', 'error')
      return
    }
    const ok = await copyText(text)
    setStatusNote(ok ? 'curl 命令已复制到剪贴板。' : '复制失败。', ok ? 'success' : 'error')
    return
  }

  if (action === 'export-json') {
    const task = context.exports?.task
    if (!task) {
      setStatusNote('无法生成导出数据。', 'error')
      return
    }
    if (task.resource) {
      task.resource.status = item.status || task.resource.status
      task.resource.hasCookieHeader = !!item.hasCookieHeader
      task.resource.hasAuthorizationHeader = !!item.hasAuthorizationHeader
      task.resource.cookieState = item.hasCookieHeader ? 'present-redacted' : 'not-observed'
      task.resource.authorizationState = item.hasAuthorizationHeader ? 'present-redacted' : 'not-observed'
      task.exportedAt = new Date().toISOString()
    }
    const json = JSON.stringify(task, null, 2)
    const ok = await copyText(json)
    if (ok) {
      setStatusNote('任务 JSON 已复制到剪贴板。', 'success')
      chrome.runtime.sendMessage({
        type: Shared.MESSAGE_TYPES.SET_MEDIA_STATUS,
        tabId: currentTabId,
        key: key,
        status: 'exported',
      })
    } else {
      setStatusNote('复制失败。', 'error')
    }
  }
}

async function handleDetailAction(key, action) {
  const item = findMediaByKey(key)
  if (!item) return

  if (action === 'copy-url') {
    const ok = await copyText(item.url || '')
    setStatusNote(ok ? 'URL 已复制。' : '复制失败。', ok ? 'success' : 'error')
    return
  }

  if (action === 'copy-referer') {
    const ok = await copyText(item.referer || '')
    setStatusNote(ok ? 'Referer 已复制。' : '复制失败。', ok ? 'success' : 'error')
  }
}

tabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('.tab-btn')
  if (!button || button.disabled) return
  activeTab = button.dataset.cat
  const counts = { video: 0, image: 0, audio: 0, other: 0 }
  normalizedMedia.forEach((item) => {
    counts[item._category] += 1
  })
  renderTabs(counts)
  renderActiveList()
})

mediaListEl.addEventListener('click', (event) => {
  const thumb = event.target.closest('.js-thumb')
  if (thumb?.dataset.url) {
    previewImgEl.src = thumb.dataset.url
    previewMaskEl.classList.add('show')
    return
  }

  const expandButton = event.target.closest('.js-expand')
  if (expandButton) {
    const key = expandButton.dataset.key
    if (expandedKeys.has(key)) {
      expandedKeys.delete(key)
    } else {
      expandedKeys.add(key)
    }
    renderActiveList()
    return
  }

  const biliMergeBtn = event.target.closest('.js-bili-merge')
  if (biliMergeBtn) {
    const item = findMediaByKey(biliMergeBtn.dataset.key)
    if (!item) return
    const cmd = buildBiliMergeCommand(item)
    if (!cmd) {
      setStatusNote('未找到音频轨道，无法生成合并命令。', 'error')
      return
    }
    copyText(cmd).then((ok) => {
      setStatusNote(ok ? 'ffmpeg 合并命令已复制到剪贴板，粘贴到终端执行即可。' : '复制失败。', ok ? 'success' : 'error')
    })
    return
  }

  const streamButton = event.target.closest('.js-stream-action')
  if (streamButton) {
    handleStreamAction(streamButton.dataset.key, streamButton.dataset.action)
    return
  }

  const detailButton = event.target.closest('.js-detail-action')
  if (detailButton) {
    handleDetailAction(detailButton.dataset.key, detailButton.dataset.action)
    return
  }

  const button = event.target.closest('.btn-dl')
  if (!button) return
  const item = findMediaById(button.dataset.id) || findMediaByKey(button.dataset.key)
  if (!item) return
  downloadMedia(item, button)
})

document.getElementById('btnClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.CLEAR_MEDIA }, () => {
    currentMedia = []
    normalizedMedia = []
    streamContextByKey.clear()
    pendingStreamKeys.clear()
    expandedKeys.clear()
    mediaListEl.innerHTML = ''
    tabsEl.innerHTML = ''
    emptyTip.style.display = 'block'
    countBadge.textContent = '0 个资源'
    setStatusNote('', 'info')
  })
})

document.getElementById('btnPin').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id
    if (!tabId) return
    chrome.tabs.sendMessage(tabId, { type: Shared.MESSAGE_TYPES.TOGGLE_DOCK_PANEL }, () => {
      window.close()
    })
  })
})

btnSettingsEl?.addEventListener('click', () => {
  settingsPanelEl?.classList.toggle('show')
})

document.addEventListener('click', (event) => {
  if (!settingsPanelEl?.classList.contains('show')) return
  const inPanel = settingsPanelEl.contains(event.target)
  const onButton = btnSettingsEl?.contains(event.target)
  if (!inPanel && !onButton) settingsPanelEl.classList.remove('show')
})

setVideoEl?.addEventListener('change', () => updateCaptureSettings({ video: !!setVideoEl.checked }))
setImageEl?.addEventListener('change', () => updateCaptureSettings({ image: !!setImageEl.checked }))
setAudioEl?.addEventListener('change', () => updateCaptureSettings({ audio: !!setAudioEl.checked }))
setOtherEl?.addEventListener('change', () => updateCaptureSettings({ other: !!setOtherEl.checked }))

sortSelectEl?.addEventListener('change', () => {
  sortMode = sortSelectEl.value || 'time'
  renderActiveList()
})

document.getElementById('btnBatchUrls')?.addEventListener('click', async () => {
  const list = getVisibleList()
  const urls = list.map((item) => item.url).filter(Boolean).join('\n')
  const ok = await copyText(urls)
  setStatusNote(ok ? `${list.length} 条 URL 已复制。` : '复制失败。', ok ? 'success' : 'error')
})

document.getElementById('btnBatchFfmpeg')?.addEventListener('click', async () => {
  const list = getVisibleList().filter((item) => isManifestItem(item))
  if (!list.length) {
    setStatusNote('当前分类下没有流媒体索引文件。', 'warn')
    return
  }

  setStatusNote(`正在分析 ${list.length} 个流媒体索引...`, 'info')
  const commands = []
  for (const item of list) {
    const context = await ensureStreamContext(item)
    const cmd = context?.exports?.commands?.ffmpeg || context?.command || ''
    if (cmd) commands.push(cmd)
  }

  if (!commands.length) {
    setStatusNote('没有可用的 ffmpeg 命令。', 'warn')
    return
  }

  const ok = await copyText(commands.join('\n\n'))
  setStatusNote(ok ? `${commands.length} 条 ffmpeg 命令已复制。` : '复制失败。', ok ? 'success' : 'error')
})

document.getElementById('btnBatchDownload')?.addEventListener('click', () => {
  const list = getVisibleList().filter((item) => !isManifestItem(item))
  if (!list.length) {
    setStatusNote('当前分类下没有可直接下载的资源。', 'warn')
    return
  }

  let done = 0
  let failed = 0
  setStatusNote(`开始批量下载 ${list.length} 个资源...`, 'info')

  for (const item of list) {
    chrome.runtime.sendMessage(
      {
        type: Shared.MESSAGE_TYPES.DOWNLOAD,
        tabId: currentTabId,
        key: getItemKey(item),
        frameId: item.frameId,
        url: item.url,
        filename: item.filename,
        category: Shared.normalizeCategory(item),
        contentType: item.contentType,
        referer: item.referer,
        sizeBytes: item.sizeBytes,
        requestHeaders: item.requestHeaders || {},
        responseHeaders: item.responseHeaders || {},
      },
      (resp) => {
        if (resp?.ok) done++
        else failed++
        if (done + failed >= list.length) {
          setStatusNote(`批量下载完成：${done} 成功${failed ? `，${failed} 失败` : ''}。`, failed ? 'warn' : 'success')
        }
      }
    )
  }
})

if (previewMaskEl && previewImgEl) {
  previewMaskEl.addEventListener('click', () => {
    previewMaskEl.classList.remove('show')
    previewImgEl.src = ''
  })
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === Shared.MESSAGE_TYPES.MEDIA_UPDATED) {
    loadSniffData()
  }
})

loadCaptureSettings()
loadSniffData()
