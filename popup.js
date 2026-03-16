/**
 * 媒体嗅探下载器 - Popup 逻辑
 */

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

let currentMedia = []
let activeTab = 'video'
let normalizedMedia = []
let captureSettings = { video: true, image: true, audio: true, other: true }

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

const TAB_ORDER = ['video', 'image', 'audio', 'other']
const TAB_LABEL = {
  video: '视频',
  image: '图片',
  audio: '音频',
  other: '其他',
}

const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus)(\?|$)/i
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd)(\?|$)/i
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i

function normalizeCategory(m) {
  const c = String(m.category || '').toLowerCase()
  if (c === 'audio' || c === 'video' || c === 'image') return c
  const ct = String(m.contentType || '').toLowerCase()
  if (ct.startsWith('audio/') || ct.includes('aac') || ct.includes('ogg')) return 'audio'
  if (ct.startsWith('video/') || ct.includes('mpegurl') || ct.includes('mp2t') || ct.includes('dash+xml')) return 'video'
  if (ct.startsWith('image/')) return 'image'
  const u = String(m.url || '')
  if (AUDIO_EXT_RE.test(u)) return 'audio'
  if (VIDEO_EXT_RE.test(u)) return 'video'
  if (IMAGE_EXT_RE.test(u)) return 'image'
  return 'other'
}

function typeLabel(category) {
  if (category === 'video') return '<span class="tag video">视频</span>'
  if (category === 'audio') return '<span class="tag audio">音频</span>'
  if (category === 'image') return '<span class="tag image">图片</span>'
  return '<span class="tag other">其他</span>'
}

function applySettingInputs() {
  if (setVideoEl) setVideoEl.checked = !!captureSettings.video
  if (setImageEl) setImageEl.checked = !!captureSettings.image
  if (setAudioEl) setAudioEl.checked = !!captureSettings.audio
  if (setOtherEl) setOtherEl.checked = !!captureSettings.other
}

function updateCaptureSettings(nextSettings) {
  captureSettings = { ...captureSettings, ...nextSettings }
  chrome.runtime.sendMessage({ type: 'setCaptureSettings', settings: captureSettings }, (resp) => {
    if (resp?.settings) captureSettings = resp.settings
    applySettingInputs()
    loadSniffData()
  })
}

function loadCaptureSettings() {
  chrome.runtime.sendMessage({ type: 'getCaptureSettings' }, (resp) => {
    if (resp?.settings) captureSettings = resp.settings
    applySettingInputs()
  })
}

function loadSniffData() {
  chrome.runtime.sendMessage({ type: 'getMedia' }, (resp) => {
    if (!resp) return
    const { media, tabUrl } = resp
    currentMedia = media

    if (tabUrl) {
      try {
        pageUrlEl.textContent = new URL(tabUrl).hostname
        pageUrlEl.title = tabUrl
      } catch (_) {}
    }

    countBadge.textContent = `${media.length} 个资源`

    if (!media.length) {
      mediaListEl.innerHTML = ''
      emptyTip.style.display = 'block'
      return
    }
    emptyTip.style.display = 'none'

    normalizedMedia = media.map((m, i) => ({ ...m, _idx: i, _category: normalizeCategory(m) }))
    const counts = { video: 0, image: 0, audio: 0, other: 0 }
    normalizedMedia.forEach((m) => {
      counts[m._category] += 1
    })

    if (counts[activeTab] === 0) {
      const firstNonEmpty = TAB_ORDER.find((k) => counts[k] > 0)
      activeTab = firstNonEmpty || 'video'
    }

    renderTabs(counts)
    renderActiveList()
  })
}

function renderTabs(counts) {
  tabsEl.innerHTML = TAB_ORDER.map((k) => {
    const activeClass = k === activeTab ? 'active' : ''
    const disabled = (counts[k] || 0) === 0 ? 'disabled' : ''
    return `<button class="tab-btn ${activeClass}" data-cat="${k}" ${disabled}>${TAB_LABEL[k]} (${counts[k] || 0})</button>`
  }).join('')

  tabsEl.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return
      activeTab = btn.dataset.cat
      renderTabs(counts)
      renderActiveList()
    })
  })
}

function renderActiveList() {
  const list = normalizedMedia
    .filter((m) => m._category === activeTab)
    .sort((a, b) => (b.time || 0) - (a.time || 0))
  if (!list.length) {
    mediaListEl.innerHTML = ''
    emptyTip.style.display = 'block'
    return
  }

  emptyTip.style.display = 'none'
  mediaListEl.innerHTML = list.map((m) => {
    const sizeInfo = m.size ? `<span>${escHtml(m.size)}</span>` : ''
    const typeInfo = m.contentType ? `<span>${escHtml(m.contentType)}</span>` : ''
    const platformInfo = m.platform ? `<span>${escHtml(m.platform)}</span>` : ''
    const timeStr = m.time ? new Date(m.time).toLocaleTimeString() : ''
    const previewHtml = m._category === 'image'
      ? `<img class="thumb js-thumb" data-url="${escHtml(m.url || '')}" src="${escHtml(m.url || '')}" alt="img" />`
      : ''

    return `<div class="media-item">
      <div class="row">
        ${typeLabel(m._category)}
        ${previewHtml}
        <span class="filename" title="${escHtml(m.filename || 'media')}">${escHtml(m.filename || 'media')}</span>
        <button class="btn-dl" data-idx="${m._idx}">下载</button>
      </div>
      <div class="meta">${sizeInfo}${typeInfo}${platformInfo}<span>${escHtml(timeStr)}</span></div>
    </div>`
  }).join('')

  mediaListEl.querySelectorAll('.btn-dl').forEach((btn) => {
    btn.addEventListener('click', () => downloadMedia(parseInt(btn.dataset.idx, 10)))
  })
  mediaListEl.querySelectorAll('.js-thumb').forEach((img) => {
    img.addEventListener('click', () => {
      const url = img.dataset.url
      if (!url || !previewMaskEl || !previewImgEl) return
      previewImgEl.src = url
      previewMaskEl.classList.add('show')
    })
    img.addEventListener('error', () => {
      img.style.display = 'none'
    })
  })
}

function downloadMedia(idx) {
  const m = currentMedia[idx]
  if (!m) return
  const btn = mediaListEl.querySelectorAll('.btn-dl')[idx]
  if (btn) btn.textContent = '下载中'

  chrome.runtime.sendMessage(
    {
      type: 'download',
      url: m.url,
      filename: m.filename,
      category: normalizeCategory(m),
      contentType: m.contentType,
      referer: m.referer,
    },
    (resp) => {
      if (resp?.ok) {
        if (btn) {
          btn.textContent = '完成'
          setTimeout(() => {
            btn.textContent = '下载'
          }, 1500)
        }
      } else if (btn) {
        btn.textContent = '失败'
        if (resp?.error) {
          btn.title = resp.error
          console.warn('下载失败:', resp.error)
        }
        setTimeout(() => {
          btn.textContent = '下载'
          btn.title = ''
        }, 1500)
      }
    }
  )
}

document.getElementById('btnClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearMedia' }, () => {
    currentMedia = []
    normalizedMedia = []
    mediaListEl.innerHTML = ''
    tabsEl.innerHTML = ''
    emptyTip.style.display = 'block'
    countBadge.textContent = '0 个资源'
  })
})

document.getElementById('btnPin').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id
    if (!tabId) return
    chrome.tabs.sendMessage(tabId, { type: 'toggleDockPanel' }, () => {
      window.close()
    })
  })
})

btnSettingsEl?.addEventListener('click', () => {
  settingsPanelEl?.classList.toggle('show')
})

document.addEventListener('click', (e) => {
  if (!settingsPanelEl?.classList.contains('show')) return
  const inPanel = settingsPanelEl.contains(e.target)
  const onBtn = btnSettingsEl?.contains(e.target)
  if (!inPanel && !onBtn) settingsPanelEl.classList.remove('show')
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

loadCaptureSettings()
loadSniffData()
setInterval(loadSniffData, 2000)
