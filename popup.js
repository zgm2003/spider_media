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

const streamContextById = new Map()
const pendingStreamIds = new Set()

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

const TAB_ORDER = ['video', 'image', 'audio', 'other']
const TAB_LABEL = {
  video: '视频',
  image: '图片',
  audio: '音频',
  other: '其他',
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

function isManifestItem(item) {
  return Shared.getDownloadMode(item) === 'manifest'
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
  const validIds = new Set(currentMedia.map((item) => item.id))
  for (const itemId of Array.from(streamContextById.keys())) {
    if (!validIds.has(itemId)) streamContextById.delete(itemId)
  }
  for (const itemId of Array.from(pendingStreamIds)) {
    if (!validIds.has(itemId)) pendingStreamIds.delete(itemId)
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

function getContextSummaryHtml(item) {
  const context = streamContextById.get(item.id)
  if (!context) return ''

  const detailHtml = (context.details || [])
    .slice(0, 4)
    .map((detail) => `<div>${Shared.escapeHtml(detail)}</div>`)
    .join('')

  return `<div class="stream-summary">
    <div class="stream-title">${Shared.escapeHtml(context.summary || '流媒体分析已就绪')}</div>
    ${detailHtml}
  </div>`
}

function getStreamToolsHtml(item) {
  if (!isManifestItem(item)) return ''

  const isPending = pendingStreamIds.has(item.id)
  const analyzeLabel = isPending ? '分析中...' : streamContextById.has(item.id) ? '刷新分析' : '分析'
  const copyLabel = isPending ? '处理中...' : '复制 ffmpeg'
  const disabled = isPending ? 'disabled' : ''

  return `<div class="stream-tools">
    <button class="btn-alt js-stream-action" data-action="analyze" data-id="${Shared.escapeHtml(item.id)}" ${disabled}>${analyzeLabel}</button>
    <button class="btn-alt js-stream-action" data-action="copy-command" data-id="${Shared.escapeHtml(item.id)}" ${disabled}>${copyLabel}</button>
  </div>`
}

function renderActiveList() {
  const list = normalizedMedia
    .filter((item) => item._category === activeTab)
    .sort((left, right) => (right.time || 0) - (left.time || 0))

  if (!list.length) {
    mediaListEl.innerHTML = ''
    emptyTip.style.display = 'block'
    return
  }

  emptyTip.style.display = 'none'

  mediaListEl.innerHTML = list.map((item) => {
    const previewHtml = item._category === 'image'
      ? `<img class="thumb js-thumb" data-url="${Shared.escapeHtml(item.url || '')}" src="${Shared.escapeHtml(item.url || '')}" alt="preview" />`
      : ''
    const meta = [
      item.size ? `<span>${Shared.escapeHtml(item.size)}</span>` : '',
      item.contentType ? `<span>${Shared.escapeHtml(item.contentType)}</span>` : '',
      item.platform ? `<span>${Shared.escapeHtml(item.platform)}</span>` : '',
      item.time ? `<span>${Shared.escapeHtml(new Date(item.time).toLocaleTimeString())}</span>` : '',
    ].filter(Boolean).join('')
    const note = item.downloadNotice ? `<div class="note">${Shared.escapeHtml(item.downloadNotice)}</div>` : ''

    return `<div class="media-item">
      <div class="row">
        ${typeLabel(item._category)}
        ${streamLabel(item)}
        ${previewHtml}
        <span class="filename" title="${Shared.escapeHtml(item.filename || 'media')}">${Shared.escapeHtml(item.filename || 'media')}</span>
        <button class="btn-dl" data-id="${Shared.escapeHtml(item.id)}">下载</button>
      </div>
      <div class="meta">${meta}</div>
      ${note}
      ${getStreamToolsHtml(item)}
      ${getContextSummaryHtml(item)}
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

function downloadMedia(itemId, buttonEl) {
  const item = findMediaById(itemId)
  if (!item || !buttonEl) return

  buttonEl.textContent = '下载中...'
  chrome.runtime.sendMessage(
    {
      type: Shared.MESSAGE_TYPES.DOWNLOAD,
      tabId: currentTabId,
      frameId: item.frameId,
      url: item.url,
      filename: item.filename,
      category: Shared.normalizeCategory(item),
      contentType: item.contentType,
      referer: item.referer,
      sizeBytes: item.sizeBytes,
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
  return new Promise((resolve) => {
    pendingStreamIds.add(item.id)
    renderActiveList()

    chrome.runtime.sendMessage(
      {
        type: Shared.MESSAGE_TYPES.GET_STREAM_CONTEXT,
        tabId: currentTabId,
        frameId: item.frameId,
        url: item.url,
        filename: item.filename,
        category: item.category,
        categoryHint: item.categoryHint,
        contentType: item.contentType,
        referer: item.referer,
        force: !!forceRefresh,
      },
      (resp) => {
        pendingStreamIds.delete(item.id)
        if (resp?.ok && resp.context) {
          streamContextById.set(item.id, resp.context)
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

async function handleStreamAction(itemId, action) {
  const item = findMediaById(itemId)
  if (!item || !isManifestItem(item)) return

  if (action === 'analyze') {
    await requestStreamContext(item, true)
    return
  }

  let context = streamContextById.get(item.id)
  if (!context) {
    context = await requestStreamContext(item, false)
  }

  if (!context?.command) {
    setStatusNote('这个资源暂时无法生成 ffmpeg 命令。', 'error')
    return
  }

  const copied = await copyText(context.command)
  setStatusNote(
    copied ? 'ffmpeg 命令已复制到剪贴板。' : '复制失败，浏览器拒绝了剪贴板权限。',
    copied ? 'success' : 'error'
  )
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

  const streamButton = event.target.closest('.js-stream-action')
  if (streamButton) {
    handleStreamAction(streamButton.dataset.id, streamButton.dataset.action)
    return
  }

  const button = event.target.closest('.btn-dl')
  if (!button) return
  downloadMedia(button.dataset.id, button)
})

document.getElementById('btnClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.CLEAR_MEDIA }, () => {
    currentMedia = []
    normalizedMedia = []
    streamContextById.clear()
    pendingStreamIds.clear()
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
