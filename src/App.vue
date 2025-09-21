<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import ThreeViewport from './components/ThreeViewport.vue'
import { parseSMF, computeWorldSize, chooseStride, downsampleHeightField, u16ToFloatHeights, type SMFParsed } from './lib/smf'
import { resolveMapPackageFromZip } from './lib/archive'
import { parseMapinfoLua } from './lib/mapinfo'
import { pickDirectoryAndCollectFiles } from './lib/folder'
import Toolbar from './components/app/Toolbar.vue'
import StatusBar from './components/app/StatusBar.vue'
import PerfDrawer from './components/app/PerfDrawer.vue'
import FilesExplorer from './components/panels/FilesExplorer.vue'
import { filesState } from './state/files.ts'

const smf = ref<SMFParsed | null>(null)
const errorMsg = ref<string | null>(null)

const widthWorld = ref(0)
const lengthWorld = ref(0)

const heights = ref<Float32Array | null>(null)
const gridW = ref(0)
const gridL = ref(0)
const strideUsed = ref(1)

const showMetal = ref(false)
const wireframe = ref(false)
const showGrid = ref(true)
const fps = ref<number | null>(null)
const fpsHovering = ref(false)
const fpsPinned = ref(false)

/* Panel visibility */
const showLeftPanel = ref(true)
const showRightPanel = ref(true)
// App container ref for width computation during drag
const appRef = ref<HTMLDivElement | null>(null)

/* Splitter width (must match CSS .divider flex-basis) */
const DIV_W = 6

// Panel widths (persisted)
const parsePx = (v: string | null, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const leftWidth = ref<number>(parsePx(localStorage.getItem('be.leftWidth'), 320))
const rightWidth = ref<number>(parsePx(localStorage.getItem('be.rightWidth'), 520))

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/* No static clamping at init; allow full range and prevent crossing only at runtime */

let dragSide: 'left' | 'right' | null = null
let dragStartX = 0
let dragStartWidth = 0

function startDrag(side: 'left'|'right', e: MouseEvent) {
  dragSide = side
  dragStartX = e.clientX
  dragStartWidth = side === 'left' ? leftWidth.value : rightWidth.value
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  e.preventDefault()
}

function onDragMove(e: MouseEvent) {
  if (!dragSide) return
  const dx = e.clientX - dragStartX

  // Compute dynamic bounds so panels never cross each other
  const appW = appRef.value?.clientWidth || window.innerWidth
  const reserved = (showLeftPanel.value ? DIV_W : 0) + (showRightPanel.value ? DIV_W : 0)
  const available = Math.max(0, appW - reserved)

  if (dragSide === 'left') {
    const maxLeft = Math.max(0, available - (showRightPanel.value ? rightWidth.value : 0))
    const next = dragStartWidth + dx
    leftWidth.value = Math.min(Math.max(0, next), maxLeft)
  } else {
    const maxRight = Math.max(0, available - (showLeftPanel.value ? leftWidth.value : 0))
    const next = dragStartWidth - dx
    rightWidth.value = Math.min(Math.max(0, next), maxRight)
  }
  scheduleResizeEvent()
}

function onDragEnd() {
  if (!dragSide) return
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  localStorage.setItem('be.leftWidth', String(leftWidth.value))
  localStorage.setItem('be.rightWidth', String(rightWidth.value))
  // ensure final viewport resize
  try { window.dispatchEvent(new Event('resize')) } catch {}
  dragSide = null
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
})

// Debounced resize events so ThreeViewport reflows while dragging
let resizeTimer: number | null = null
function scheduleResizeEvent() {
  if (resizeTimer) window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    try { window.dispatchEvent(new Event('resize')) } catch {}
  }, 80)
}

/* Persist on change as well */
watch(leftWidth, (v) => localStorage.setItem('be.leftWidth', String(v)))
watch(rightWidth, (v) => localStorage.setItem('be.rightWidth', String(v)))

/* When panels are shown/hidden, trigger a debounced resize so ThreeViewport recalculates */
watch(showLeftPanel, (v) => {
  if (!v && dragSide === 'left') onDragEnd()
  // Fire after layout updates to avoid any transient overlap, plus a debounced follow-up.
  requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')) } catch {} })
  scheduleResizeEvent()
})
watch(showRightPanel, (v) => {
  if (!v && dragSide === 'right') onDragEnd()
  // Fire after layout updates to avoid any transient overlap, plus a debounced follow-up.
  requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')) } catch {} })
  scheduleResizeEvent()
})

// Top-bar hidden inputs for quick load actions
const smfInputTop = ref<HTMLInputElement | null>(null)
const pkgInputTop = ref<HTMLInputElement | null>(null)
const folderInputTop = ref<HTMLInputElement | null>(null)
const mapinfoInputTop = ref<HTMLInputElement | null>(null)

function triggerTopSmf() { smfInputTop.value?.click() }
function triggerTopPkg() { pkgInputTop.value?.click() }
function triggerTopFolder() { folderInputTop.value?.click() }
function triggerTopMapinfo() { mapinfoInputTop.value?.click() }

function toggleLeftPanel() { showLeftPanel.value = !showLeftPanel.value }
function toggleRightPanel() { showRightPanel.value = !showRightPanel.value }

// Collapsible sections (left/right panels)
const collapseFilesLeft = ref(false)
const collapseDetection = ref(false)
const collapseMapDefinition = ref(false)
const collapseMapInfo = ref(false)
const collapseDisplay = ref(false)
const collapseBaseTexture = ref(false)
const collapseMapinfoResources = ref(false)
const collapseMapinfoJson = ref(false)
const collapseOverlays = ref(false)

// Folder-based textures
type ImgEntry = { name: string; url: string; file: File }
const folderImages = ref<ImgEntry[]>([])
const baseColorUrl = ref<string | null>(null)
const baseColorIsDDS = ref(false)

// Overlay controls built from folder images
type OverlayControl = { name: string; url: string; visible: boolean; opacity: number; isDDS?: boolean }
const overlays = ref<OverlayControl[]>([])

// Full file browser of uploaded content
type UploadedEntry = { path: string; url?: string; isImage: boolean; isDDS: boolean; file?: File }
const uploadedFiles = computed(() => filesState.uploadedFiles)

// Tree view state
type TreeNode = { name: string; path: string; isDir: boolean; children?: TreeNode[]; entry?: UploadedEntry }
const treeExpanded = computed<Set<string>>({
  get: () => filesState.expandedSet,
  set: (v) => { filesState.expandedSet = v },
})
const selectedPath = computed<string | null>({
  get: () => filesState.selectedPath,
  set: (v) => { filesState.selectedPath = v },
})

function expandAllFiles() {
  const acc = new Set<string>()
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.isDir) {
        acc.add(n.path)
        if (n.children && Array.isArray(n.children)) walk(n.children)
      }
    }
  }
  walk(fileTree.value)
  treeExpanded.value = acc
}
function collapseAllFiles() {
  treeExpanded.value = new Set()
}

function buildTree(entries: UploadedEntry[]): TreeNode[] {
  const root: Record<string, any> = {}
  for (const e of entries) {
    const parts = e.path.split(/[\\/]+/).filter(Boolean)
    let cur = root
    let curPath = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      curPath = curPath ? `${curPath}/${part}` : part
      cur.children = cur.children || {}
      if (!cur.children[part]) {
        cur.children[part] = { name: part, path: curPath, isDir: i < parts.length - 1, children: {} }
      }
      cur = cur.children[part]
      if (i === parts.length - 1) {
        cur.isDir = false
        cur.entry = e
      }
    }
  }
  function toArray(node: any): TreeNode[] {
    if (!node.children) return []
    const arr: TreeNode[] = Object.values(node.children).map((n: any) => ({
      name: n.name,
      path: n.path,
      isDir: n.isDir,
      children: n.isDir ? toArray(n) : undefined,
      entry: n.entry,
    }))
    arr.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1
      if (!a.isDir && b.isDir) return 1
      return a.name.localeCompare(b.name)
    })
    return arr
  }
  return toArray(root)
}
const fileTree = computed<TreeNode[]>(() => buildTree(uploadedFiles.value))

function toggleNode(path: string) {
  const s = new Set(treeExpanded.value)
  if (s.has(path)) s.delete(path)
  else s.add(path)
  treeExpanded.value = s
}

function overlayFromEntry(e: UploadedEntry) {
  if (!e.isImage || !e.url) return
  const exists = overlays.value.find(o => o.url === e.url)
  if (!exists) {
    overlays.value.push({ name: e.path, url: e.url, visible: true, opacity: 1, isDDS: e.isDDS })
  } else {
    exists.visible = true
    exists.opacity = 1
  }
}

function useAsBaseFromEntry(e: UploadedEntry) {
  if (!e.isImage || !e.url) return
  baseColorUrl.value = e.url
  baseColorIsDDS.value = !!e.isDDS
}

async function parseMapinfoFromEntry(e: UploadedEntry) {
  if (!e.file) return
  try {
    const txt = await e.file.text()
    mapinfoJSON.value = parseMapinfoLua(txt)
    mapinfoPath.value = e.path
    console.info('Parsed mapinfo.lua (tree):', mapinfoJSON.value)
    tryApplyBaseTextureFromMapinfo()
    maybeRescaleHeights()
  } catch (err) {
    console.warn('Failed to parse mapinfo.lua from tree:', err)
  }
}

async function loadSmfFromEntry(e: UploadedEntry) {
  if (!e.file) return
  if (!/\.smf$/i.test(e.path)) return
  await loadSMFFromFile(e.file)
}

// Child ref for fullscreen API (still available if needed)
const viewportRef = ref<InstanceType<typeof ThreeViewport> | null>(null)

const header = computed(() => smf.value?.header)
const mapinfoJSON = ref<any | null>(null)
const mapinfoPath = ref<string | null>(null)
const prettyMapinfo = computed(() => mapinfoJSON.value ? JSON.stringify(mapinfoJSON.value, null, 2) : '')

const envFromMapinfo = computed(() => {
  const m = mapinfoJSON.value as any
  if (!m) return null
  const env: any = {}
  const atm = m.atmosphere || {}
  const lig = m.lighting || {}

  if (lig.groundAmbientColor) env.ambient = tuple3(lig.groundAmbientColor)
  if (atm.sunColor) env.sunColor = tuple3(atm.sunColor)
  const sd = lig.sunDir || atm.skyDir
  if (sd) env.sunDir = tuple3(sd)
  if (atm.skyColor) env.skyColor = tuple3(atm.skyColor)
  if (atm.fogStart !== undefined) env.fogStart = Number(atm.fogStart)
  if (atm.fogEnd !== undefined) env.fogEnd = Number(atm.fogEnd)
  if (atm.fogColor) env.fogColor = tuple3(atm.fogColor)

  return env
})

const autoResolveAfterSmf = ref(false)
const dirPickerSupported = ref<boolean>(typeof (window as any) !== 'undefined' && !!(window as any).showDirectoryPicker)

function revokeFolderUrls() {
  for (const e of folderImages.value) URL.revokeObjectURL(e.url)
  for (const e of filesState.uploadedFiles) if (e.url) URL.revokeObjectURL(e.url)
  folderImages.value = []
  filesState.uploadedFiles = []
  baseColorUrl.value = null
  overlays.value = []
}

function pickBaseTextureURL(entries: ImgEntry[]): string | null {
  if (entries.length === 0) return null
  // Prefer common base color names (including .dds)
  const prefer = /(base|diffuse|albedo|color|texture)\.(png|jpe?g|webp|bmp|tga|dds)$/i
  const found = entries.find(e => prefer.test(e.name))
  const candidate = found ?? entries[0]
  return candidate ? candidate.url : null
}

// Normalize a variety of tuple-like inputs to [number, number, number]
const tuple3 = (v: any): [number, number, number] => {
  if (Array.isArray(v)) return [Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)]
  if (v && typeof v === 'object') {
    return [Number((v as any).x ?? (v as any)[0] ?? 0), Number((v as any).y ?? (v as any)[1] ?? 0), Number((v as any).z ?? (v as any)[2] ?? 0)]
  }
  return [0, 0, 0]
}

// Find an image entry by matching the end of its path (case-insensitive)
function findImageBySuffix(relPath: string): ImgEntry | undefined {
  const lower = relPath.toLowerCase().replace(/^[./\\]+/, '')
  return folderImages.value.find(e => e.name.toLowerCase().endsWith(lower))
}

// Find an overlay entry by matching the end of its path (case-insensitive)
function findOverlayBySuffix(relPath: string): OverlayControl | undefined {
  const lower = relPath.toLowerCase().replace(/^[./\\]+/, '')
  return overlays.value.find(e => e.name.toLowerCase().endsWith(lower))
}

// Ensure that a referenced texture from mapinfo is visible as an overlay
function ensureOverlayVisible(relPath: string, opacity = 1): void {
  const ov = findOverlayBySuffix(relPath)
  if (ov) {
    ov.visible = true
    ov.opacity = opacity
  }
}
// Ensure overlay by exact URL (used when user binds a file from the picker)
function ensureOverlayByUrl(url: string, opacity = 1): void {
  if (!url) return
  const ov = overlays.value.find(e => e.url === url)
  if (ov) {
    ov.visible = true
    ov.opacity = opacity
  }
}

// Find an SMF in a FileList by suffix (case-insensitive)
function findSmfInFileListBySuffix(files: FileList, relPath: string): File | null {
  const lower = relPath.toLowerCase().replace(/^[./\\]+/, '')
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)!
    const name = (f.webkitRelativePath || f.name).toLowerCase()
    if (name.endsWith(lower)) return f
  }
  return null
}

// Find an SMF in a collected directory listing by suffix (case-insensitive)
function findSmfInCollectedBySuffix(collected: { path: string; file: File }[], relPath: string): File | null {
  const lower = relPath.toLowerCase().replace(/^[./\\]+/, '')
  for (const item of collected) {
    const name = item.path.toLowerCase()
    if (name.endsWith(lower)) return item.file
  }
  return null
}

// Resource management (mapinfo.resources and mapinfo.smf texture overrides)
const resourceKeys = {
  smf: ['minimapTex','metalmapTex','typemapTex','grassmapTex'] as readonly string[],
  resources: [
    'grassBladeTex','grassShadingTex','detailTex','specularTex',
    'splatDetailTex','splatDistrTex','skyReflectModTex',
    'detailNormalTex','lightEmissionTex','parallaxHeightTex'
  ] as readonly string[],
} as const

const resourceSelections = ref<Record<string, string>>({})
const showOnlyResourceOverlays = ref(false)
const overlaysToRender = computed(() => {
  if (!mapinfoJSON.value || !showOnlyResourceOverlays.value) return overlays.value
  const urls = new Set(Object.values(resourceSelections.value).filter(Boolean))
  return overlays.value.filter(o => urls.has(o.url))
})

// SMT discovery from uploaded content and mapinfo references
const smtFilesFound = computed(() =>
  uploadedFiles.value
    .filter((e: UploadedEntry) => /\.smt$/i.test(e.path))
    .map((e: UploadedEntry) => e.path)
    .sort((a: string, b: string) => a.localeCompare(b))
)

const smtRefsFromMapinfo = computed(() => {
  const m = mapinfoJSON.value as any
  const out: string[] = []
  if (!m || !m.smf) return out
  const smf = m.smf
  for (const k of Object.keys(smf)) {
    if (/^smtfilename\d*$/i.test(k)) {
      const v = smf[k]
      if (typeof v === 'string' && v.trim()) out.push(v)
    }
  }
  return out
})

// Mapinfo summary fields (basic metadata)
const mapinfoSummary = computed(() => {
  const m = mapinfoJSON.value as any
  if (!m) return null
  return {
    name: m.name,
    shortname: m.shortname,
    version: m.version,
    author: m.author,
    description: m.description,
    mapfile: m.mapfile,
  }
})

function resourceId(section: 'smf'|'resources', key: string): string {
  return `${section}.${key}`
}

function onResourceSelected(id: string) {
  const url = resourceSelections.value[id] ?? ''
  if (url) ensureOverlayByUrl(url, 1)
}

// Initialize/refresh resource bindings when mapinfo or files change
watch([mapinfoJSON, folderImages], () => {
  const m: any = mapinfoJSON.value || {}
  const smfSec: any = m.smf || {}
  const resSec: any = m.resources || {}

  const bindIfMissing = (section: 'smf'|'resources', key: string, path: any) => {
    const id = resourceId(section, key)
    if (resourceSelections.value[id] === undefined) {
      resourceSelections.value[id] = ''
    }
    if (!resourceSelections.value[id] && typeof path === 'string' && path.trim()) {
      const found = findImageBySuffix(path)
      if (found) resourceSelections.value[id] = found.url
    }
  }

  ;(resourceKeys.smf as readonly string[]).forEach((k) => bindIfMissing('smf', k as string, (smfSec as any)?.[k as any]))
  ;(resourceKeys.resources as readonly string[]).forEach((k) => bindIfMissing('resources', k as string, (resSec as any)?.[k as any]))

  // Do not auto-enable overlays; user decides which to show
  // (resourceSelections may still be pre-bound for convenience)
}, { immediate: true })

// If mapinfo.lua specifies texture overrides, attempt to select one as base texture
function tryApplyBaseTextureFromMapinfo() {
  const m = mapinfoJSON.value as any
  if (!m) return
  const smfSec = m.smf || {}
  const res = m.resources || {}

  // Prefer a specific base texture if provided
  const baseCandidates: (string | undefined)[] = [
    res.detailTex,
    res.splatDetailTex,
    smfSec.minimapTex, // fallback to minimap if it's the only thing present
  ]
  // Do not auto-select a base texture based on mapinfo; user decides

  // Ensure notable mapinfo textures appear as overlays
  const overlayCandidates: (string | undefined)[] = [
    smfSec.minimapTex,
    smfSec.metalmapTex,
    smfSec.typemapTex,
    smfSec.grassmapTex,
    res.skyReflectModTex,
    res.specularTex,
    res.detailNormalTex,
    res.lightEmissionTex,
    res.parallaxHeightTex,
  ]
  // Do not auto-enable overlays from mapinfo; user enables as needed
}

// Read smf min/max overrides from mapinfo if present
function getSmfOverrides() {
  const m = mapinfoJSON.value as any
  const smfSec = m?.smf || {}
  // Accept both camelCase and lowercase keys seen in the wild
  const min = smfSec.minHeight ?? smfSec.minheight
  const max = smfSec.maxHeight ?? smfSec.maxheight
  if (typeof min === 'number' || typeof max === 'number') {
    return {
      min: typeof min === 'number' ? min : undefined,
      max: typeof max === 'number' ? max : undefined,
    }
  }
  return null
}

// If mapinfo overrides min/max heights, rescale our heightFloat and downsampled grid
function maybeRescaleHeights() {
  const parsed = smf.value
  if (!parsed) return
  const overrides = getSmfOverrides()
  if (!overrides) return
  const min = overrides.min ?? parsed.header.minHeight
  const max = overrides.max ?? parsed.header.maxHeight
  // If same range, skip
  if (min === parsed.header.minHeight && max === parsed.header.maxHeight) return

  const floatHeights = u16ToFloatHeights(parsed.heightU16, min, max)
  const { out, outW, outL } = downsampleHeightField(
    floatHeights,
    parsed.header.width,
    parsed.header.length,
    strideUsed.value
  )
  heights.value = out
  gridW.value = outW
  gridL.value = outL
}

async function handleFiles(files: FileList | null) {
  errorMsg.value = null
  if (!files || files.length === 0) return
  const file = files?.item(0)
  if (!file) return
  try {
    const buf = await file.arrayBuffer()
    const parsed = parseSMF(buf)
    smf.value = parsed

    const ws = computeWorldSize(parsed.header)
    widthWorld.value = ws.widthWorld
    lengthWorld.value = ws.lengthWorld

    // Limit geometry density for large maps for performance
    const segMax = Math.max(parsed.header.width, parsed.header.length)
    const stride = chooseStride(segMax, 512)
    strideUsed.value = stride

    const { out, outW, outL } = downsampleHeightField(
      parsed.heightFloat,
      parsed.header.width,
      parsed.header.length,
      stride
    )
    heights.value = out
    gridW.value = outW
    gridL.value = outL
    // Apply mapinfo smf.minHeight/maxHeight overrides if present
    maybeRescaleHeights()
    if (dirPickerSupported.value && autoResolveAfterSmf.value) {
      try {
        await resolveFromFolder()
      } catch (e) {
        console.warn('Folder resolve skipped:', e)
      }
    }
  } catch (err) {
    console.error(err)
    errorMsg.value = (err as Error).message || String(err)
    smf.value = null
    heights.value = null
    gridW.value = 0
    gridL.value = 0
    widthWorld.value = 0
    lengthWorld.value = 0
  }
}

const loadSMFFromFile = async (file: File): Promise<void> => {
  try {
    const buf = await file.arrayBuffer()
    const parsed = parseSMF(buf)
    smf.value = parsed

    const ws = computeWorldSize(parsed.header)
    widthWorld.value = ws.widthWorld
    lengthWorld.value = ws.lengthWorld

    const segMax = Math.max(parsed.header.width, parsed.header.length)
    const stride = chooseStride(segMax, 512)
    strideUsed.value = stride

    const { out, outW, outL } = downsampleHeightField(
      parsed.heightFloat,
      parsed.header.width,
      parsed.header.length,
      stride
    )
    heights.value = out
    gridW.value = outW
    gridL.value = outL
    // Apply mapinfo smf.minHeight/maxHeight overrides if present
    maybeRescaleHeights()
    if (dirPickerSupported.value && autoResolveAfterSmf.value) {
      try {
        await resolveFromFolder()
      } catch (e) {
        console.warn('Folder resolve skipped:', e)
      }
    }
  } catch (err) {
    console.error(err)
    errorMsg.value = (err as Error).message || String(err)
  }
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  handleFiles(input.files)
}

async function onMapinfoFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return
  const f = files.item(0)!
  try {
    const txt = await f.text()
    mapinfoJSON.value = parseMapinfoLua(txt)
    mapinfoPath.value = f.name
    console.info('Parsed mapinfo.lua (manual):', mapinfoJSON.value)
    tryApplyBaseTextureFromMapinfo()
    maybeRescaleHeights()
  } catch (err) {
    console.warn('Failed to parse manual mapinfo.lua:', err)
    mapinfoJSON.value = null
    mapinfoPath.value = null
  }
}

async function onFolderChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  revokeFolderUrls()
  if (!files || files.length === 0) return
  const imgs: ImgEntry[] = []
  const fileList: UploadedEntry[] = []
  let foundSmf: File | null = null
  let mapinfoFile: File | null = null

  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)!
    const name = f.webkitRelativePath || f.name

    if (/\.smf$/i.test(name)) {
      foundSmf = f
    }
    if (/(^|\/)mapinfo\.lua$/i.test(name)) {
      // Prefer root-level mapinfo.lua over maphelper/mapinfo.lua if both exist
      if (!mapinfoFile || /^mapinfo\.lua$/i.test(name)) {
        mapinfoFile = f
      }
    }
    // Track all files for file browser; build URLs for images (including .dds)
    const isDDS = /\.dds$/i.test(name)
    const isImage = /^image\//i.test(f.type) || isDDS || /\.(png|jpe?g|webp|bmp|tga)$/i.test(name)
    let url: string | undefined
    if (isImage) url = URL.createObjectURL(f)
    fileList.push({ path: name, url, isImage, isDDS, file: f })

    // Maintain image list used by overlays/base
    if (isImage && url) {
      imgs.push({ name, url, file: f })
    }
  }

  // Sort for stable UI
  fileList.sort((a: UploadedEntry, b: UploadedEntry) => a.path.localeCompare(b.path))
  filesState.uploadedFiles = fileList

  imgs.sort((a: ImgEntry, b: ImgEntry) => a.name.localeCompare(b.name))
  folderImages.value = imgs

  // Do not auto-select a base texture; let the user choose
  baseColorUrl.value = null
  baseColorIsDDS.value = false

  // Build overlays with DDS hint so viewer uses DDSLoader even for blob: URLs
  overlays.value = imgs.map(img => ({
    name: img.name,
    url: img.url,
    visible: false,
    opacity: 1,
    isDDS: /\.dds$/i.test(img.file.name || img.name),
  }))

  // Parse mapinfo.lua if present
  if (mapinfoFile) {
    try {
      const txt = await mapinfoFile.text()
      mapinfoJSON.value = parseMapinfoLua(txt)
      mapinfoPath.value = mapinfoFile.name
      console.info('Parsed mapinfo.lua (folder):', mapinfoJSON.value)
      tryApplyBaseTextureFromMapinfo()
      // Prefer SMF from mapinfo.mapfile if present
      const mfPath: unknown = (mapinfoJSON.value as any)?.mapfile
      if (typeof mfPath === 'string' && mfPath.trim()) {
        const smfOverride = findSmfInFileListBySuffix(files, mfPath)
        if (smfOverride) foundSmf = smfOverride
      }
      // Rescale heights if smf.minHeight/maxHeight overrides present
      maybeRescaleHeights()
    } catch (err) {
      console.warn('Failed to parse folder mapinfo.lua:', err)
      mapinfoJSON.value = null
      mapinfoPath.value = null
    }
  } else {
    mapinfoJSON.value = null
    mapinfoPath.value = null
  }

  // Do not auto-load SMF from folder; user can choose "Load SMF" in the explorer
}
async function handlePackage(file: File) {
  errorMsg.value = null
  revokeFolderUrls()

  const name = file.name || ''
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'sd7') {
    errorMsg.value = 'SD7 (7z) not supported in browser yet. Convert to .sdz (zip) and retry.'
    return
  }
  if (ext !== 'sdz' && ext !== 'zip' && ext !== 'smf') {
    errorMsg.value = 'Unsupported package type. Please select a .sdz or .zip map package (or a .smf file).'
    return
  }

  if (ext === 'smf') {
    await loadSMFFromFile(file)
    return
  }

  try {
    const pkg = await resolveMapPackageFromZip(file)

    // file browser for package: all archive file paths
    const fileList: UploadedEntry[] = pkg.filePaths.map(p => {
      const isDDS = /\.dds$/i.test(p)
      const isImage = isDDS || /\.(png|jpe?g|webp|bmp|tga)$/i.test(p)
      return {
        path: p,
        url: isImage ? pkg.images.find(i => i.path === p)?.blobUrl : undefined,
        isImage,
        isDDS,
        file: undefined,
      }
    })
    fileList.sort((a: UploadedEntry, b: UploadedEntry) => a.path.localeCompare(b.path))
    filesState.uploadedFiles = fileList

    // images -> folderImages/overlays
    const imgs: ImgEntry[] = pkg.images.map(img => ({
      name: img.path,
      url: img.blobUrl,
      file: new File([new Blob([])], img.path),
    }))
    imgs.sort((a: ImgEntry, b: ImgEntry) => a.name.localeCompare(b.name))
    folderImages.value = imgs

    // Do not auto-select a base texture; let the user choose
    baseColorUrl.value = null
    baseColorIsDDS.value = false

    overlays.value = imgs.map(img => ({
      name: img.name,
      url: img.url,
      visible: false,
      opacity: 1,
      isDDS: /\.dds$/i.test(img.name),
    }))

    // parse SMF
    const parsed = parseSMF(pkg.smfBuffer)
    smf.value = parsed

    const ws = computeWorldSize(parsed.header)
    widthWorld.value = ws.widthWorld
    lengthWorld.value = ws.lengthWorld

    const segMax = Math.max(parsed.header.width, parsed.header.length)
    const stride = chooseStride(segMax, 512)
    strideUsed.value = stride

    const { out, outW, outL } = downsampleHeightField(
      parsed.heightFloat,
      parsed.header.width,
      parsed.header.length,
      stride
    )
    heights.value = out
    gridW.value = outW
    gridL.value = outL

    // parse mapinfo if present
    if (pkg.mapinfoText) {
      try {
        mapinfoJSON.value = parseMapinfoLua(pkg.mapinfoText)
        mapinfoPath.value = pkg.mapinfoPath ?? '(embedded)'
        console.info('Parsed mapinfo.lua:', mapinfoJSON.value)
        tryApplyBaseTextureFromMapinfo()
        // Rescale heights if smf.minHeight/maxHeight overrides present
        maybeRescaleHeights()
      } catch (e) {
        console.warn('Failed to parse mapinfo.lua:', e)
        mapinfoJSON.value = null
        mapinfoPath.value = null
      }
    } else {
      mapinfoJSON.value = null
      mapinfoPath.value = null
    }
  } catch (err) {
    console.error(err)
    errorMsg.value = (err as Error).message || String(err)
  }
}

function onPackageChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return
  const f = files.item(0)!
  handlePackage(f)
}

async function resolveFromFolder() {
  if (!dirPickerSupported.value) {
    errorMsg.value = 'Directory picker not supported. Use "Load map folder" instead.'
    return
  }
  try {
    const collected = await pickDirectoryAndCollectFiles()
    // Build ImgEntry[] and full file browser; detect .smf / mapinfo.lua
    const imgs: ImgEntry[] = []
    const fileList: UploadedEntry[] = []
    let foundSmf: File | null = null
    let mapinfoFile: File | null = null

    for (const item of collected) {
      const name = item.path

      if (/\.smf$/i.test(name)) {
        // Prefer a maps/<name>.smf if multiple are present
        if (!foundSmf || /^maps\/.+\.smf$/i.test(name)) {
          foundSmf = item.file
        }
      }
      if (/(^|\/)mapinfo\.lua$/i.test(name)) {
        // Prefer root-level mapinfo.lua over maphelper/mapinfo.lua if both exist
        if (!mapinfoFile || /^mapinfo\.lua$/i.test(name)) {
          mapinfoFile = item.file
        }
      }
      const isDDS = /\.dds$/i.test(name)
      const isImage = isDDS || /\.(png|jpe?g|webp|bmp|tga)$/i.test(name)
      const url = isImage ? URL.createObjectURL(item.file) : undefined
      if (isImage && url) {
        imgs.push({ name, url, file: item.file })
      }
      fileList.push({ path: name, url, isImage, isDDS, file: item.file })
    }

    // Sort & apply images + file browser
    fileList.sort((a: UploadedEntry, b: UploadedEntry) => a.path.localeCompare(b.path))
    filesState.uploadedFiles = fileList

    imgs.sort((a: ImgEntry, b: ImgEntry) => a.name.localeCompare(b.name))
    folderImages.value = imgs

    // Do not auto-select a base texture; let the user choose
    baseColorUrl.value = null
    baseColorIsDDS.value = false

    overlays.value = imgs.map(img => ({
      name: img.name,
      url: img.url,
      visible: false,
      opacity: 1,
      isDDS: /\.dds$/i.test(img.file.name || img.name),
    }))

    // Parse mapinfo.lua if present
    if (mapinfoFile) {
      try {
        const txt = await mapinfoFile.text()
        mapinfoJSON.value = parseMapinfoLua(txt)
        mapinfoPath.value = mapinfoFile.name
        console.info('Parsed mapinfo.lua (dir picker):', mapinfoJSON.value)
        tryApplyBaseTextureFromMapinfo()
        // Prefer SMF from mapinfo.mapfile if present
        const mfPath: unknown = (mapinfoJSON.value as any)?.mapfile
        if (typeof mfPath === 'string' && mfPath.trim()) {
          const smfOverride = findSmfInCollectedBySuffix(collected, mfPath)
          if (smfOverride) foundSmf = smfOverride
        }
        // Rescale heights if smf.minHeight/maxHeight overrides present
        maybeRescaleHeights()
      } catch (err) {
        console.warn('Failed to parse directory mapinfo.lua:', err)
        mapinfoJSON.value = null
        mapinfoPath.value = null
      }
    } else {
      mapinfoJSON.value = null
      mapinfoPath.value = null
    }

    // Do not auto-load SMF from folder; user can choose "Load SMF" in the explorer
  } catch (err) {
    console.error(err)
    errorMsg.value = (err as Error).message || String(err)
  }
}

watch(baseColorUrl, (newUrl) => {
  const baseEntry = folderImages.value.find(e => e.url === newUrl)
  baseColorIsDDS.value = !!baseEntry && /\.dds$/i.test(baseEntry?.file.name || baseEntry?.name)
})
</script>

<script lang="ts">
import { defineComponent, h, type PropType } from 'vue'

export default defineComponent({
  name: 'App',
  components: {
    TreeNodeView: defineComponent({
      name: 'TreeNodeView',
      props: {
        node: { type: Object as PropType<Record<string, any>>, required: true },
        expandedSet: { type: Object as PropType<Set<string>>, required: true },
        selectedPath: { type: String as PropType<string | null>, required: false, default: null },
        onToggle: { type: Function as PropType<(p: string) => void>, required: true },
        onSelect: { type: Function as PropType<(p: string) => void>, required: true },
        onParseMapinfo: { type: Function as PropType<(e: any) => void>, required: true },
        onLoadSmf: { type: Function as PropType<(e: any) => void>, required: true },
        onOverlay: { type: Function as PropType<(e: any) => void>, required: true },
        onUseAsBase: { type: Function as PropType<(e: any) => void>, required: true },
      },
      setup(props) {
        return () => {
          const n: any = props.node
          const expanded = n.isDir ? props.expandedSet.has(n.path) : false

          const row = n.isDir
            ? h('div', { class: ['fb-row', props.selectedPath === n.path ? 'selected' : ''], onClick: () => props.onSelect(n.path) }, [
                h('div', { class: 'fb-path' }, [
                  h('span', { class: 'twisty', onClick: (e: any) => { e.stopPropagation(); props.onToggle(n.path) } }, expanded ? '▼' : '▶'),
                  h('span', { class: 'icon' }, '📁'),
                  h('span', { class: 'dir' }, n.name),
                ]),
                h('div', { class: 'fb-tags' }, [ h('span', { class: 'tag' }, 'Folder') ]),
              ])
            : h('div', { class: ['fb-row', props.selectedPath === n.path ? 'selected' : ''], onClick: () => props.onSelect(n.path) }, [
                h('div', { class: 'fb-path' }, [
                  h('span', { class: 'icon' }, n.entry?.isDDS ? '🗜️' : (n.entry?.isImage ? '🖼️' : '📄')),
                  h('span', { class: 'file' }, n.name)
                ]),
                h('div', { class: 'fb-tags' }, [
                  n.entry?.isDDS ? h('span', { class: 'tag' }, 'DDS') : (n.entry?.isImage ? h('span', { class: 'tag' }, 'Image') : null),
                  /\.lua$/i.test(n.path) ? h('button', {
                    class: 'small',
                    disabled: !n.entry?.file,
                    onClick: () => props.onParseMapinfo(n.entry),
                  }, 'Parse mapinfo') : null,
                  /\.smf$/i.test(n.path) ? h('button', {
                    class: 'small',
                    disabled: !n.entry?.file,
                    onClick: () => props.onLoadSmf(n.entry),
                  }, 'Load SMF') : null,
                  n.entry?.isImage ? h('button', {
                    class: 'small',
                    onClick: () => props.onOverlay(n.entry),
                  }, 'Overlay') : null,
                  n.entry?.isImage ? h('button', {
                    class: 'small',
                    onClick: () => props.onUseAsBase(n.entry),
                  }, 'Use as base') : null,
                ]),
              ])

          const children = n.isDir && expanded && n.children && n.children.length
            ? h('div', { class: 'fb-children' },
                n.children.map((c: any) =>
                  h('TreeNodeView', {
                    node: c,
                    key: c.path,
                    expandedSet: props.expandedSet,
                    selectedPath: props.selectedPath,
                    onToggle: props.onToggle,
                    onSelect: props.onSelect,
                    onParseMapinfo: props.onParseMapinfo,
                    onLoadSmf: props.onLoadSmf,
                    onOverlay: props.onOverlay,
                    onUseAsBase: props.onUseAsBase,
                  })
                )
              )
            : null

          return h('div', { class: 'fb-node' }, [row, children])
        }
      },
    }),
  },
})
</script>

<template>
  <Toolbar>
    <button class="small" @click="triggerTopSmf">Load .smf</button>
    <button class="small" @click="triggerTopPkg">Load .sdz/.zip</button>
    <button class="small" @click="triggerTopFolder">Load folder</button>
    <button class="small" @click="triggerTopMapinfo">Load mapinfo.lua</button>
    <button class="small" v-if="heights && dirPickerSupported" @click="resolveFromFolder">Resolve folder</button>
    <button class="small" @click="toggleLeftPanel">{{ showLeftPanel ? 'Hide' : 'Show' }} Left</button>
    <button class="small" @click="toggleRightPanel">{{ showRightPanel ? 'Hide' : 'Show' }} Right</button>

    <input ref="smfInputTop" type="file" accept=".smf,application/octet-stream" @change="onFileChange" style="display:none" />
    <input ref="pkgInputTop" type="file" accept=".sdz,.zip,.sd7" @change="onPackageChange" style="display:none" />
    <input ref="folderInputTop" type="file" webkitdirectory directory multiple @change="onFolderChange" style="display:none" />
    <input ref="mapinfoInputTop" type="file" accept=".lua" @change="onMapinfoFileChange" style="display:none" />
  </Toolbar>
  <div class="app" ref="appRef">
    <aside class="sidebar left" v-if="showLeftPanel" :style="{ width: leftWidth + 'px' }">
      <div class="section" v-if="uploadedFiles.length">
        <h3 class="collapsible" @click="collapseFilesLeft = !collapseFilesLeft"><span class="twisty">{{ collapseFilesLeft ? '▶' : '▼' }}</span> Files <span class="header-actions"><button class="small" @click.stop="expandAllFiles()">Expand all</button><button class="small" @click.stop="collapseAllFiles()">Collapse all</button></span></h3>
        <div class="file-browser" v-show="!collapseFilesLeft">
          <FilesExplorer
            :nodes="fileTree"
            :expanded-set="treeExpanded"
            :selected-path="selectedPath"
            @toggle="toggleNode"
            @select="(p: string) => (selectedPath = p)"
            @parseMapinfo="parseMapinfoFromEntry"
            @loadSmf="loadSmfFromEntry"
            @overlay="overlayFromEntry"
            @useAsBase="useAsBaseFromEntry"
          />
        </div>
      </div>
    </aside>
    <div v-if="showLeftPanel" class="divider divider-left" @mousedown="(e) => startDrag('left', e)"></div>
    <div class="main">
      <div v-if="!heights" class="empty">
        <p>Select an .smf file to visualize the heightmap.</p>
        <p>You can also load a map folder (MAP_EXAMPLES_NOCOMMIT) to pick textures and overlays.</p>
      </div>
      <ThreeViewport
        v-else
        ref="viewportRef"
        :widthWorld="widthWorld"
        :lengthWorld="lengthWorld"
        :gridW="gridW"
        :gridL="gridL"
        :heights="heights"
        :showMetal="showMetal"
        :metalU8="smf?.metalU8"
        :metalW="smf?.metalWidth"
        :metalL="smf?.metalLength"
        :baseColorUrl="baseColorUrl"
        :baseColorIsDDS="baseColorIsDDS"
        :wireframe="wireframe"
        :showGrid="showGrid"
        :overlays="overlaysToRender"
        :env="envFromMapinfo"
        @fps="fps = $event"
      />
    </div>

    <div v-if="showRightPanel" class="divider divider-right" @mousedown="(e) => startDrag('right', e)"></div>

    <aside class="sidebar right" v-if="showRightPanel" :style="{ width: rightWidth + 'px' }">

      <div class="section">
        <h3 class="collapsible" @click="collapseDetection = !collapseDetection"><span class="twisty">{{ collapseDetection ? '▶' : '▼' }}</span> Detection</h3>
        <div class="info" v-show="!collapseDetection">
          <div><b>Files uploaded:</b></div><div>{{ uploadedFiles.length }}</div>
          <div><b>mapinfo.lua:</b></div><div>{{ mapinfoPath || 'not found' }}</div>
          <div><b>SMT files found:</b></div><div>{{ smtFilesFound.length }}</div>
          <div v-if="smtFilesFound.length"><b>First SMT:</b></div><div v-if="smtFilesFound.length">{{ smtFilesFound[0] }}</div>
          <div v-if="smtRefsFromMapinfo.length"><b>SMT refs (mapinfo):</b></div><div v-if="smtRefsFromMapinfo.length">{{ smtRefsFromMapinfo.join(', ') }}</div>
        </div>
      </div>

      <div class="section" v-if="mapinfoSummary">
        <h3 class="collapsible" @click="collapseMapDefinition = !collapseMapDefinition"><span class="twisty">{{ collapseMapDefinition ? '▶' : '▼' }}</span> Map Definition</h3>
        <div class="info" v-show="!collapseMapDefinition">
          <div><b>Name:</b></div><div>{{ mapinfoSummary.name }}</div>
          <div><b>Shortname:</b></div><div>{{ mapinfoSummary.shortname }}</div>
          <div><b>Version:</b></div><div>{{ mapinfoSummary.version }}</div>
          <div><b>Author:</b></div><div>{{ mapinfoSummary.author }}</div>
          <div><b>Mapfile:</b></div><div>{{ mapinfoSummary.mapfile }}</div>
        </div>
      </div>

      <div class="section" v-if="header">
        <h3 class="collapsible" @click="collapseMapInfo = !collapseMapInfo"><span class="twisty">{{ collapseMapInfo ? '▶' : '▼' }}</span> Map Info</h3>
        <div class="info" v-show="!collapseMapInfo">
          <div><b>Size:</b> {{ header.width }}x{{ header.length }} squares</div>
          <div><b>Square:</b> {{ header.squareSize }}</div>
          <div><b>Height:</b> [{{ header.minHeight }}, {{ header.maxHeight }}]</div>
          <div><b>Stride:</b> {{ strideUsed }}</div>
        </div>
      </div>

      <div class="section">
        <h3 class="collapsible" @click="collapseDisplay = !collapseDisplay"><span class="twisty">{{ collapseDisplay ? '▶' : '▼' }}</span> Display</h3>
        <label class="toggle" v-show="!collapseDisplay">
          <input type="checkbox" v-model="showMetal" />
          <span>Metal</span>
        </label>
        <label class="toggle" v-show="!collapseDisplay">
          <input type="checkbox" v-model="wireframe" />
          <span>Wireframe</span>
        </label>
        <label class="toggle" v-show="!collapseDisplay">
          <input type="checkbox" v-model="showGrid" />
          <span>Grid</span>
        </label>
      </div>

      <div class="section">
        <h3 class="collapsible" @click="collapseBaseTexture = !collapseBaseTexture"><span class="twisty">{{ collapseBaseTexture ? '▶' : '▼' }}</span> Base Texture</h3>
        <select v-model="baseColorUrl" v-show="!collapseBaseTexture">
          <option :value="null">None</option>
          <option v-for="img in folderImages" :key="img.url" :value="img.url">{{ img.name }}</option>
        </select>
      </div>

      <div class="section" v-if="mapinfoJSON">
        <h3 class="collapsible" @click="collapseMapinfoResources = !collapseMapinfoResources"><span class="twisty">{{ collapseMapinfoResources ? '▶' : '▼' }}</span> Mapinfo Resources</h3>
        <label class="toggle" v-show="!collapseMapinfoResources">
          <input type="checkbox" v-model="showOnlyResourceOverlays" />
          <span>Show only overlays bound to mapinfo resources</span>
        </label>
        <button class="file" v-show="!collapseMapinfoResources" @click="
          Object.entries(resourceSelections.value).forEach(([id, url]) => url && ensureOverlayByUrl(url as string, 1))
        ">Enable all referenced</button>

        <div class="resources" v-show="!collapseMapinfoResources">
          <div class="res-group">
            <div class="res-group-title">smf</div>
            <div
              v-for="key in (resourceKeys.smf as unknown as string[])"
              :key="'smf.'+key"
              class="res-item"
            >
              <div class="res-key">smf.{{ key }}</div>
              <div class="res-path" :title="(mapinfoJSON?.smf && mapinfoJSON.smf[String(key)]) || '(none)'">
                {{ (mapinfoJSON?.smf && mapinfoJSON.smf[String(key)]) || '(none)' }}
              </div>
              <select
                v-model="resourceSelections['smf.' + String(key)]"
                @change="onResourceSelected('smf.' + String(key))"
              >
                <option :value="''">(unbound)</option>
                <option v-for="img in folderImages" :key="img.url" :value="img.url">{{ img.name }}</option>
              </select>
              <div class="res-actions">
                <button class="small" @click="onResourceSelected('smf.' + String(key))" :disabled="!resourceSelections['smf.' + String(key)]">Enable overlay</button>
                <button class="small" @click="baseColorUrl = (resourceSelections['smf.' + String(key)] as any)" :disabled="!resourceSelections['smf.' + String(key)]">Use as base</button>
              </div>
            </div>
          </div>

          <div class="res-group">
            <div class="res-group-title">resources</div>
            <div
              v-for="key in (resourceKeys.resources as unknown as string[])"
              :key="'resources.'+key"
              class="res-item"
            >
              <div class="res-key">resources.{{ key }}</div>
              <div class="res-path" :title="(mapinfoJSON?.resources && mapinfoJSON.resources[String(key)]) || '(none)'">
                {{ (mapinfoJSON?.resources && mapinfoJSON.resources[String(key)]) || '(none)' }}
              </div>
              <select
                v-model="resourceSelections['resources.' + String(key)]"
                @change="onResourceSelected('resources.' + String(key))"
              >
                <option :value="''">(unbound)</option>
                <option v-for="img in folderImages" :key="img.url" :value="img.url">{{ img.name }}</option>
              </select>
              <div class="res-actions">
                <button class="small" @click="onResourceSelected('resources.' + String(key))" :disabled="!resourceSelections['resources.' + String(key)]">Enable overlay</button>
                <button
                  class="small"
                  v-if="key==='detailTex' || key==='splatDetailTex'"
                  @click="baseColorUrl = (resourceSelections['resources.' + String(key)] as any)"
                  :disabled="!resourceSelections['resources.' + String(key)]"
                >
                  Use as base
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="section" v-if="mapinfoJSON">
        <h3 class="collapsible" @click="collapseMapinfoJson = !collapseMapinfoJson"><span class="twisty">{{ collapseMapinfoJson ? '▶' : '▼' }}</span> mapinfo.lua (parsed)</h3>
        <pre class="json-dump" v-show="!collapseMapinfoJson">{{ prettyMapinfo }}</pre>
      </div>


      <div class="section" v-if="folderImages.length">
        <h3 class="collapsible" @click="collapseOverlays = !collapseOverlays"><span class="twisty">{{ collapseOverlays ? '▶' : '▼' }}</span> Overlays</h3>
        <div class="overlays" v-show="!collapseOverlays">
          <div v-for="ov in overlays" :key="ov.url" class="overlay-item">
            <label class="ov-label">
              <input type="checkbox" v-model="ov.visible" />
              <span class="ov-name">{{ ov.name }}</span>
            </label>
            <input class="ov-slider" type="range" min="0" max="1" step="0.01" v-model.number="ov.opacity" />
          </div>
        </div>
      </div>
    </aside>
  </div>
  <PerfDrawer
    v-if="fpsHovering || fpsPinned"
    :fps="fps ?? undefined"
    :peek="true"
  />
  <StatusBar
    :hasHeights="!!heights"
    :files="uploadedFiles.length"
    :mapName="mapinfoSummary?.name ?? ''"
    :error="errorMsg"
    :fps="fps ?? undefined"
    @fpsHover="(h) => (fpsHovering = h)"
    @fpsClick="() => (fpsPinned = !fpsPinned)"
  />
</template>

<style scoped>
.app {
  display: flex;
  width: 100vw;
  height: calc(100vh - 40px - 28px); /* account for Toolbar (40px) + StatusBar (28px) */
  background: #0b0c0e;
  color: #ddd;
}
.main {
  flex: 1 1 auto;
  position: relative;
  min-width: 0;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  overflow: hidden; /* prevent viewport canvas from bleeding under side panels */
  z-index: 1; /* keep main below sidebars */
}
.empty {
  position: absolute;
  z-index: 1;
  top: 12px;
  left: 12px;
  padding: 12px 14px;
  background: rgba(0, 0, 0, 0.45);
  border: 1px solid #222;
  border-radius: 6px;
  color: #bbb;
}
/* Base sidebar styling */
.sidebar {
  height: 100%;
  box-sizing: border-box;
  background: #111214;
  padding: 12px;
  overflow: auto;
  position: relative; /* enable z-index */
  z-index: 2; /* ensure sidebars paint above the main viewport */
}

/* Left panel */
.sidebar.left {
  width: 320px;
  border-right: 1px solid #222;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* let inner scroller handle overflow */
}

/* Right panel */
.sidebar.right {
  width: 520px;        /* default right panel */
  border-left: 1px solid #222;
}
.section {
  margin-bottom: 16px;
}
.section h3 {
  margin: 0 0 8px;
  font-size: 1rem;
  color: #9fb0ff;
}
h3.collapsible {
  cursor: pointer;
  user-select: none;
}
h3.collapsible .twisty {
  display: inline-block;
  width: 16px;
  text-align: center;
  color: #9fb0ff;
  margin-right: 6px;
  cursor: pointer;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 6px 10px;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #1b1d22;
  color: #e6e6e6;
  margin-right: 8px;
  margin-bottom: 6px;
}
.file input[type="file"] {
  display: none;
}
.status.warn {
  color: #ff7676;
}
.info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
}
.info b {
  color: #bbb;
}
select {
  width: 100%;
  background: #1a1c20;
  color: #e6e6e6;
  border: 1px solid #2a2a2a;
  padding: 6px;
  border-radius: 4px;
}
.overlays {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.overlay-item {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  background: #16181c;
}
.ov-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ov-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-slider {
  width: 100%;
}

/* Mapinfo resource UI */
.resources {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.res-group {
  border: 1px solid #2a2a2a;
  background: #15171b;
  border-radius: 6px;
  padding: 8px;
}
.res-group-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: #b8c6ff;
}
.res-item {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border: 1px solid #26282d;
  background: #0f1115;
  border-radius: 4px;
  margin-bottom: 6px;
}
.res-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  color: #9ab0ff;
  font-size: 0.9rem;
}
.res-path {
  color: #9aa0aa;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.res-actions {
  display: inline-flex;
  gap: 6px;
}
button.small {
  padding: 4px 8px;
  font-size: 0.85rem;
}

/* File browser */
.file-browser {
  border: 1px solid #2a2a2a;
  background: #15171b;
  border-radius: 6px;
  /* fill the left panel height */
  flex: 1 1 auto;
  min-height: 0; /* required for flex children to shrink in Firefox/Chromium */
  overflow: auto;
  padding: 4px 0;
}

/* Ensure the Files section in the left panel can expand to full height */
.sidebar.left .section {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.fb-node {
  margin-left: 0;
}
.fb-children {
  margin-left: 16px;
  border-left: 1px dashed #2a2a2a;
}
.fb-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #22252c;
  user-select: none;
  cursor: default;
}
.fb-row:last-child { border-bottom: none; }
.fb-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #cfd4e6;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.twisty {
  display: inline-block;
  width: 16px;
  text-align: center;
  color: #9fb0ff;
}
.dir {
  color: #b8c6ff;
  font-weight: 600;
}
.file {
  color: #d9e0ff;
}
.fb-row.selected {
  background: #1a1c20;
}
.fb-path .icon {
  color: #c0c4d4;
}
.section h3 .header-actions button.small {
  margin-left: 6px;
}
.fb-tags {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.tag {
  background: #0f1115;
  border: 1px solid #2a2a2a;
  color: #9fb0ff;
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
}
.json-dump {
  background: #0f1115;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px;
  max-height: 240px;
  overflow: auto;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12px;
  color: #cfd4e6;
}
/* Splitter dividers */
.divider {
  flex: 0 0 6px;
  cursor: grab;
  user-select: none;
  position: relative;
  background: transparent;
  z-index: 3; /* dividers above everything for interactions */
}
.divider::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: #222;
}
.divider:hover {
  background: rgba(255, 255, 255, 0.04);
}
.divider:active {
  cursor: grabbing;
}
.divider-left {
  border-right: 1px solid #222;
}
.divider-right {
  border-left: 1px solid #222;
}
</style>
