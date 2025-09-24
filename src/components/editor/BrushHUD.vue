<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, computed } from 'vue'
import type { ResourceBus } from '../../lib/editor/resource-bus'
import { brushRegistry } from '../../lib/brushes'
import { searchAmbientCG, buildAmbientSearchUrl, resolveAmbientByIdToImage, listStamps, listUploadedStamps, type AmbientSearchResult, type StampEntry } from '../../lib/heightmaps'

type Props = {
  bus: ResourceBus
}
const props = defineProps<Props>()

const state = reactive({
  // edit
  enabled: false,
  mode: 'add' as string,
  radius: 64,
  strength: 2,
  preview: true,
  // dynamic brush params (auto UI)
  params: {} as Record<string, any>,
  // palette
  open: false,
  hoverRadius: false,
  hoverStrength: false,
  // scrubby slider
  dragging: false,
  dragWhat: '' as 'radius' | 'strength' | '',
  dragStartX: 0,
  dragStartValue: 0,
  // ambientCG search popup
  searchOpen: false,
  searching: false,
  searchResults: [] as AmbientSearchResult[],
  searchError: null as string | null,
  searchUrl: '' as string,
  searchCount: 0,
  selectingId: null as string | null,

  // Local stamps picker (bar-editor-assets/stamps)
  stampsOpen: false,
  stampsLoading: false,
  stampsError: null as string | null,
  stampsUploaded: [] as StampEntry[],
  stampsPublic: [] as StampEntry[],
})

function publishEdit(partial: Partial<{ enabled: boolean; mode: string; radius: number; strength: number; preview: boolean; params: Record<string, any> }>) {
  const next = {
    enabled: state.enabled,
    mode: state.mode,
    radius: state.radius,
    strength: state.strength,
    preview: state.preview,
    ...partial,
  }
  // update local first (for snappy UI), then bus
  state.enabled = !!next.enabled
  state.mode = String(next.mode)
  state.radius = Number(next.radius)
  state.strength = Number(next.strength)
  state.preview = !!next.preview
  if (partial && typeof (partial as any).params === 'object') {
    state.params = { ...(partial as any).params }
  }
  ;(props.bus as any).set('edit', {
    enabled: state.enabled,
    mode: state.mode,
    radius: state.radius,
    strength: state.strength,
    preview: state.preview,
    params: state.params,
  })
}

// Initial snapshot
try {
  const e = (props.bus.get('edit') as any) || {}
  if (typeof e.enabled === 'boolean') state.enabled = !!e.enabled
  if (typeof e.mode === 'string') state.mode = e.mode
  if (Number.isFinite(e.radius)) state.radius = Number(e.radius)
  if (Number.isFinite(e.strength)) state.strength = Number(e.strength)
  if (typeof e.preview === 'boolean') state.preview = !!e.preview
  if (e && typeof e.params === 'object') state.params = { ...e.params }
} catch {}
// Subscribe to external changes
let unsub: (() => void) | null = null
try {
  unsub = props.bus.subscribe('edit', (e: any) => {
    e = e || {}
    if (typeof e.enabled === 'boolean') state.enabled = !!e.enabled
    if (typeof e.mode === 'string') state.mode = String(e.mode)
    if (Number.isFinite(e.radius)) state.radius = Number(e.radius)
    if (Number.isFinite(e.strength)) state.strength = Number(e.strength)
    if (typeof e.preview === 'boolean') state.preview = !!e.preview
    if (e && typeof e.params === 'object') state.params = { ...e.params }
  })
} catch {}

onBeforeUnmount(() => {
  try { unsub?.() } catch {}
  if (state.dragging) {
    try { window.removeEventListener('mousemove', onScrubMove as any) } catch {}
    try { window.removeEventListener('mouseup', endScrub as any) } catch {}
    try { (document.body.style as any).cursor = '' } catch {}
    state.dragging = false
    state.dragWhat = ''
  }
})
onMounted(() => {
  ensureParamsForBrush()
})

// Brushes
const brushesAll = computed(() => brushRegistry.list().map((b: any) => ({ id: b.id, label: b.label || b.id })))
const common = computed(() => [
  { id: 'add', label: 'Add (raise)' },
  { id: 'remove', label: 'Remove (lower)' },
  { id: 'smooth', label: 'Smooth' },
])
const pluginBrushes = computed(() => {
  const idsCommon = new Set(common.value.map((b: any) => b.id))
  return brushesAll.value.filter((b: any) => !idsCommon.has(b.id) && b.id !== 'raise' && b.id !== 'lower')
})

// Dynamic param definitions for current brush
const currentParamDefs = computed(() => {
  try {
    const brush = brushRegistry.get(state.mode)
    const defs = (brush as any)?.params
    return Array.isArray(defs) ? defs : []
  } catch {
    return []
  }
})

function ensureParamsForBrush() {
  const defs: any[] = currentParamDefs.value as any
  const next: Record<string, any> = {}
  for (const def of defs) {
    const key = def?.key
    if (!key) continue
    let v = state.params?.[key]
    if (v === undefined) v = def.default
    next[key] = v
  }
  state.params = next
}

// Helpers to update params
function setParam(key: string, value: any) {
  const next = { ...(state.params || {}), [key]: value }
  publishEdit({ params: next })
}
function adjustParamNumber(def: any, deltaUnits: number) {
  const step = Number(def?.step ?? 1)
  const min = Number.isFinite(def?.min) ? Number(def.min) : -Infinity
  const max = Number.isFinite(def?.max) ? Number(def.max) : +Infinity
  const curr = Number((state.params || {})[def.key] ?? def.default)
  let next = curr + deltaUnits * step
  if (Number.isFinite(min)) next = Math.max(min, next)
  if (Number.isFinite(max)) next = Math.min(max, next)
  // snap to step
  if (step > 0) next = Math.round(next / step) * step
  setParam(def.key, next)
}
function onWheelParamNumber(def: any, ev: WheelEvent) {
  ev.preventDefault()
  const mult = ev.shiftKey ? 5 : 1
  adjustParamNumber(def, (ev.deltaY > 0 ? -1 : +1) * mult)
}
function toggleParamBoolean(def: any) {
  const curr = !!((state.params || {})[def.key] ?? def.default)
  setParam(def.key, !curr)
}
function cycleParamSelect(def: any) {
  const opts = Array.isArray(def?.options) ? def.options : []
  const curr = (state.params || {})[def.key] ?? def.default
  const idx = Math.max(0, opts.findIndex((o: any) => o?.value === curr))
  const next = opts[(idx + 1) % Math.max(1, opts.length)]?.value ?? curr
  setParam(def.key, next)
}
function getSelectLabel(def: any): string {
  const opts = Array.isArray(def?.options) ? def.options : []
  const curr = (state.params || {})[def.key] ?? def.default
  const found = opts.find((o: any) => o?.value === curr)
  return found?.label ?? String(curr)
}

// ambientCG search helpers
function openAmbientSearch() {
  const q = String((state.params || {})['ambientQuery'] ?? '')
  state.searchOpen = true
  state.searching = true
  state.searchError = null
  state.searchResults = []
  state.searchUrl = buildAmbientSearchUrl(q, 24)
  state.searchCount = 0
  ;(async () => {
    try {
      const results = await searchAmbientCG(q, 24)
      state.searchResults = results
      state.searchCount = Array.isArray(results) ? results.length : 0
    } catch (e: any) {
      state.searchError = e?.message || String(e)
    } finally {
      state.searching = false
    }
  })()
}
function rerunAmbientSearch() {
  const q = String((state.params || {})['ambientQuery'] ?? '')
  state.searching = true
  state.searchError = null
  state.searchResults = []
  state.searchUrl = buildAmbientSearchUrl(q, 24)
  state.searchCount = 0
  ;(async () => {
    try {
      const results = await searchAmbientCG(q, 24)
      state.searchResults = results
      state.searchCount = Array.isArray(results) ? results.length : 0
    } catch (e: any) {
      state.searchError = e?.message || String(e)
    } finally {
      state.searching = false
    }
  })()
}
function closeAmbientSearch() {
  state.searchOpen = false
}

// Local stamps helpers
async function openStampsPicker() {
  state.stampsOpen = true
  state.stampsLoading = true
  state.stampsError = null
  try {
    const uploaded = listUploadedStamps() // from user-uploaded map folder
    const builtin = await listStamps()    // from public manifest/index.json (optional)
    state.stampsUploaded = uploaded
    state.stampsPublic = builtin
  } catch (e: any) {
    state.stampsError = e?.message || String(e)
  } finally {
    state.stampsLoading = false
  }
}
async function reloadStamps() {
  await openStampsPicker()
}
function closeStampsPicker() {
  state.stampsOpen = false
}
function useStamp(s: StampEntry) {
  const path = s.url || s.path
  if (!path) return
  const next = { ...(state.params || {}) }
  if (s.isUploaded) {
    // Use the original uploaded relative path so the loader resolves into filesState.uploadedFiles
    next['sourceType'] = 'upload'
    next['uploadPath'] = s.path
  } else {
    // Built-in/public asset
    next['sourceType'] = 'asset'
    next['assetId'] = path
  }
  publishEdit({ params: next })
  state.stampsOpen = false
}
async function useAmbientResult(r: AmbientSearchResult) {
  try {
    state.selectingId = r.id
    // Resolve by asset id to get a true height/displacement map when possible
    const direct = await resolveAmbientByIdToImage(r.id)
    const url = direct || r.heightUrl || r.previewUrl
    if (url) {
      const next = { ...(state.params || {}) }
      next['sourceType'] = 'url'
      next['url'] = url
      publishEdit({ params: next })
      state.searchOpen = false
    } else {
      state.searchError = 'No suitable height/displacement image found for this asset.'
    }
  } catch (e: any) {
    state.searchError = e?.message || String(e)
  } finally {
    state.selectingId = null
  }
}

// Mapping: UI "add/remove" to 'raise'/'lower' mode for runtime
function normalizeIdForUISelect(id: string): string {
  if (id === 'raise') return 'add'
  if (id === 'lower') return 'remove'
  return id
}
function toRuntimeBrushId(id: string): string {
  if (id === 'add') return 'raise'
  if (id === 'remove') return 'lower'
  return id
}

function pickBrush(id: string) {
  state.open = false
  const runtime = toRuntimeBrushId(id)
  publishEdit({ mode: runtime })
  // Initialize params for the selected brush
  ensureParamsForBrush()
  publishEdit({ params: state.params })
}

function toggleEnabled() {
  publishEdit({ enabled: !state.enabled })
}

function adjustRadius(delta: number) {
  const step = Math.max(1, Math.round(Math.abs(delta)))
  const dir = delta > 0 ? 1 : -1
  const next = Math.max(1, Math.round(state.radius + dir * step))
  publishEdit({ radius: next })
}
function adjustStrength(delta: number) {
  // Use 0.1 steps for fractional strength; ensure small deltas still move by at least 0.05
  const step = Math.max(0.05, Math.abs(delta))
  const dir = delta > 0 ? 1 : -1
  const raw = state.strength + dir * step
  // Do not hard clamp upper bound because some brushes interpret strength as world units (e.g., terrace step size)
  const next = Math.max(0, Math.round(raw * 100) / 100)
  publishEdit({ strength: next })
}

function onWheelRadius(ev: WheelEvent) {
  ev.preventDefault()
  // Alt = fine, Shift = coarse, default = medium
  const step = ev.altKey ? 1 : ev.shiftKey ? 25 : 10
  adjustRadius(ev.deltaY > 0 ? -step : +step)
}
function onWheelStrength(ev: WheelEvent) {
  ev.preventDefault()
  // Alt = fine, Shift = coarse, default = medium
  const step = ev.altKey ? 0.5 : ev.shiftKey ? 5 : 1
  adjustStrength(ev.deltaY > 0 ? -step : +step)
}

// Photoshop-style "scrubby slider" on value fields
function startScrub(what: 'radius' | 'strength', ev: MouseEvent) {
  ev.preventDefault()
  state.dragging = true
  state.dragWhat = what
  state.dragStartX = ev.clientX
  state.dragStartValue = what === 'radius' ? state.radius : state.strength
  try { document.body.style.cursor = 'ew-resize' } catch {}
  window.addEventListener('mousemove', onScrubMove as any, { passive: true } as any)
  window.addEventListener('mouseup', endScrub as any)
}
function onScrubMove(ev: MouseEvent) {
  if (!state.dragging) return
  const dx = ev.clientX - state.dragStartX
  if (state.dragWhat === 'radius') {
    // Dynamic scrub speed by current size; Alt = fine, Shift = coarse
    const base = state.radius >= 500 ? 10 : state.radius >= 200 ? 5 : state.radius >= 100 ? 2 : 0.5
    const stepPerPx = ev.altKey ? base * 0.2 : ev.shiftKey ? base * 2 : base
    const next = Math.max(1, Math.round(state.dragStartValue + dx * stepPerPx))
    publishEdit({ radius: next })
  } else if (state.dragWhat === 'strength') {
    // Dynamic scrub speed by current strength; Alt = fine, Shift = coarse
    const base = state.strength >= 50 ? 2 : state.strength >= 10 ? 1 : 0.2
    const stepPerPx = ev.altKey ? base * 0.2 : ev.shiftKey ? base * 2 : base
    let raw = state.dragStartValue + dx * stepPerPx
    raw = Math.max(0, Math.round(raw * 100) / 100)
    publishEdit({ strength: raw })
  }
}
function endScrub() {
  if (!state.dragging) return
  state.dragging = false
  state.dragWhat = ''
  try { document.body.style.cursor = '' } catch {}
  try { window.removeEventListener('mousemove', onScrubMove as any) } catch {}
  try { window.removeEventListener('mouseup', endScrub as any) } catch {}
}
</script>

<template>
  <div class="brush-hud">
    <div class="hud-bar">
      <!-- Edit toggle -->
      <button class="pill" :class="{ on: state.enabled }" @click="toggleEnabled" title="Enable/Disable brush editing">
        <span class="dot" :class="{ on: state.enabled }"></span>
        <span>{{ state.enabled ? 'Editing ON' : 'Editing OFF' }}</span>
      </button>

      <!-- Current brush + palette -->
      <div class="group">
        <button class="btn" @click="state.open = !state.open" :title="`Select Brush (current: ${normalizeIdForUISelect(state.mode)})`">
          🖌️ {{ normalizeIdForUISelect(state.mode) }}
        </button>
        <div v-if="state.open" class="palette" @mousedown.stop>
          <div class="sec">
            <div class="sec-title">Common</div>
            <div class="grid">
              <button v-for="b in common" :key="b.id" class="cell" @click="pickBrush(b.id)">
                <div class="label">{{ b.label }}</div>
              </button>
            </div>
          </div>
          <div v-if="pluginBrushes.length" class="sec">
            <div class="sec-title">Plugins</div>
            <div class="grid">
              <button v-for="b in pluginBrushes" :key="b.id" class="cell" @click="pickBrush(b.id)">
                <div class="label">{{ b.label }}</div>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Radius -->
      <div class="group small" @wheel.passive.prevent="onWheelRadius" @mouseenter="state.hoverRadius = true" @mouseleave="state.hoverRadius = false">
        <span class="hint">Radius</span>
        <button class="btn" @click="adjustRadius(-10)">-</button>
        <div class="value" @mousedown.prevent="startScrub('radius', $event)">{{ state.radius }}</div>
        <button class="btn" @click="adjustRadius(+10)">+</button>
      </div>

      <!-- Strength -->
      <div class="group small" @wheel.passive.prevent="onWheelStrength" @mouseenter="state.hoverStrength = true" @mouseleave="state.hoverStrength = false">
        <span class="hint">Strength</span>
        <button class="btn" @click="adjustStrength(-1)">-</button>
        <div class="value" @mousedown.prevent="startScrub('strength', $event)">{{ state.strength }}</div>
        <button class="btn" @click="adjustStrength(+1)">+</button>
      </div>

      <!-- Dynamic brush params -->
      <template v-for="def in currentParamDefs" :key="def.key">
        <div v-if="def.type === 'number'" class="group small" @wheel.passive.prevent="onWheelParamNumber(def, $event)">
          <span class="hint">{{ def.label }}</span>
          <button class="btn" @click="adjustParamNumber(def, -1)">-</button>
          <div class="value">{{ (state.params?.[def.key] ?? def.default) }}</div>
          <button class="btn" @click="adjustParamNumber(def, +1)">+</button>
        </div>
        <button v-else-if="def.type === 'boolean'" class="pill" :class="{ on: !!state.params?.[def.key] }" @click="toggleParamBoolean(def)">
          <span class="dot" :class="{ on: !!state.params?.[def.key] }"></span>
          <span>{{ def.label }}</span>
        </button>
        <div v-else-if="def.type === 'select'" class="group small">
          <span class="hint">{{ def.label }}</span>
          <button class="btn" @click="cycleParamSelect(def)">{{ getSelectLabel(def) }}</button>
        </div>
        <div v-else-if="def.type === 'text'" class="group small">
          <span class="hint">{{ def.label }}</span>
          <input
            class="input"
            :placeholder="def.placeholder || ''"
            :value="(state.params?.[def.key] ?? def.default)"
            @change="(e: any) => setParam(def.key, (e.target as HTMLInputElement).value)"
            @keyup.enter="(e: any) => setParam(def.key, (e.target as HTMLInputElement).value)"
          />
          <!-- Special-case ambientCG query to expose a Search button -->
          <button
            v-if="def.key === 'ambientQuery'"
            class="btn"
            title="Search ambientCG"
            @click="openAmbientSearch"
          >
            Search
          </button>
          <button
            v-if="def.key === 'assetId'"
            class="btn"
            title="Pick from /bar-editor-assets/stamps"
            @click="openStampsPicker"
          >
            Stamps
          </button>
        </div>
      </template>

      <!-- Preview toggle -->
      <button class="pill" :class="{ on: state.preview }" @click="publishEdit({ preview: !state.preview })" title="Toggle brush preview">
        <span class="dot" :class="{ on: state.preview }"></span>
        <span>Preview</span>
      </button>
    </div>
    <!-- AmbientCG Search Modal -->
    <div v-if="state.searchOpen" class="modal">
      <div class="modal-backdrop" @click="closeAmbientSearch"></div>
      <div class="modal-panel">
        <div class="modal-header">
          <div class="title">ambientCG Search</div>
          <button class="btn close" @click="closeAmbientSearch">✕</button>
        </div>
        <div class="modal-subheader">
          <div class="url">
            <span>Request:</span>
            <a :href="state.searchUrl" target="_blank" rel="noopener">{{ state.searchUrl }}</a>
          </div>
          <div class="meta">
            <span>Results: {{ state.searchCount }}</span>
            <button class="btn small" @click="rerunAmbientSearch">Refresh</button>
      </div>
    </div>

        <div class="modal-body">
          <div v-if="state.searching" class="loading">Searching…</div>
          <div v-else-if="state.searchError" class="error">Error: {{ state.searchError }}</div>
          <div v-else class="results">
            <div
              v-for="r in state.searchResults"
              :key="r.id + (r.heightUrl || r.previewUrl)"
              class="result"
            >
              <div class="thumb-wrap">
                <img class="thumb" :src="r.previewUrl" :alt="r.title" />
              </div>
              <div class="meta">
                <div class="name" :title="r.title">{{ r.title }}</div>
                <button class="btn use" @click="useAmbientResult(r)" :disabled="state.selectingId === r.id">
                  <span v-if="state.selectingId === r.id">Using…</span>
                  <span v-else>Use Height</span>
                </button>
              </div>
            </div>
            <div v-if="!state.searchResults.length" class="empty">No results.</div>
          </div>
        </div>
      </div>
    </div>
    <!-- Local Stamps Picker Modal (moved outside ambientCG v-if so it opens independently) -->
    <div v-if="state.stampsOpen" class="modal modal-stamps">
      <div class="modal-backdrop" @click="closeStampsPicker"></div>
      <div class="modal-panel">
        <div class="modal-header">
          <div class="title">Local Stamps (/bar-editor-assets/stamps)</div>
          <button class="btn close" @click="closeStampsPicker">✕</button>
        </div>
        <div class="modal-subheader">
          <div class="meta">
            <span>Uploaded: {{ state.stampsUploaded.length }}</span>
            <span>Built‑in: {{ state.stampsPublic.length }}</span>
            <button class="btn small" @click="reloadStamps">Refresh</button>
          </div>
        </div>
        <div class="modal-body">
          <div v-if="state.stampsLoading" class="loading">Loading…</div>
          <div v-else-if="state.stampsError" class="error">Error: {{ state.stampsError }}</div>

          <template v-else>
            <div v-if="state.stampsUploaded.length" class="sec">
              <div class="sec-title">Uploaded Stamps (from map)</div>
              <div class="results">
                <div
                  v-for="s in state.stampsUploaded"
                  :key="'up:' + (s.id || s.path)"
                  class="result"
                >
                  <div class="thumb-wrap">
                    <img class="thumb" :src="s.url || s.path" :alt="s.label || s.id || s.path" />
                  </div>
                  <div class="meta">
                    <div class="name" :title="s.label || s.id || s.path">{{ s.label || s.id || s.path.split('/').pop() }}</div>
                    <button class="btn use" @click="useStamp(s)">Use</button>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="state.stampsPublic.length" class="sec">
              <div class="sec-title">Built‑in Stamps</div>
              <div class="results">
                <div
                  v-for="s in state.stampsPublic"
                  :key="'pub:' + (s.id || s.path)"
                  class="result"
                >
                  <div class="thumb-wrap">
                    <img class="thumb" :src="s.url || s.path" :alt="s.label || s.id || s.path" />
                  </div>
                  <div class="meta">
                    <div class="name" :title="s.label || s.id || s.path">{{ s.label || s.id || s.path.split('/').pop() }}</div>
                    <button class="btn use" @click="useStamp(s)">Use</button>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="!state.stampsUploaded.length && !state.stampsPublic.length" class="empty">
              No stamps found in the uploaded map (bar-editor-assets/stamps). You can also add built‑in stamps to /public/bar-editor-assets/stamps/ or define stamps/index.json.
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.brush-hud {
  position: absolute;
  /* Fill the entire viewport pane so dropdowns/modals can use full height */
  top: 8px;
  right: 8px;
  bottom: 8px;
  left: 8px;
  z-index: 20;
  pointer-events: none; /* let viewport interact; buttons enable pointer-events explicitly */
}
.hud-bar {
  display: inline-flex;
  gap: 8px;
  background: rgba(12, 14, 18, 0.85);
  border: 1px solid #2a2f3a;
  padding: 6px 8px;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  pointer-events: auto;
  align-items: center;
  flex-wrap: wrap; /* allow controls to wrap instead of overflowing horizontally */
  max-width: calc(100% - 16px); /* adapt to full pane width minus padding */
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 6px 10px;
  background: #171a20;
  border: 1px solid #2a2d34;
  color: #dfe5f2;
  cursor: pointer;
  font-size: 12px;
}
.pill.on {
  background: #1e2430;
  border-color: #3a475e;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
}
.dot.on {
  background: #5bd15b;
}

.group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  position: relative; /* ensure nested absolute dropdowns (palette) are positioned correctly */
}
.group.small .btn {
  padding: 4px 8px;
}
.hint {
  color: #9aa5b1;
  font-size: 11px;
  margin-right: 2px;
}
.value {
  min-width: 36px;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  color: #e6ebf5;
  padding: 2px 6px;
  border: 1px solid #2a2f3a;
  border-radius: 6px;
  background: #12151a;
  cursor: ew-resize;
  user-select: none;
}
.input {
  min-width: 180px;
  font-size: 12px;
  color: #e6ebf5;
  padding: 4px 6px;
  border: 1px solid #2a2f3a;
  border-radius: 6px;
  background: #12151a;
}

.btn {
  border: 1px solid #2a2f3a;
  background: #1a1f29;
  color: #dee7f7;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
}
.btn:hover {
  background: #212836;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}
.cell {
  border: 1px solid #2a2f3a;
  background: #1a1f29;
  color: #dee7f7;
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
}
.cell:hover {
  background: #212836;
}
.label {
  font-size: 12px;
  text-align: center;
}

.palette {
  position: absolute;
  top: calc(100% + 6px); /* drop directly below the brush button */
  left: 0;               /* open to the right of the button */
  right: auto;
  min-width: 360px;
  min-height: 420px;             /* start taller so it doesn't feel compressed */
  width: min(60vw, 700px);       /* allow a bit wider */
  max-height: 90vh;              /* use viewport height to allow more Y space */
  overflow: auto;
  background: rgba(12, 14, 18, 0.95);
  border: 1px solid #2a2f3a;
  border-radius: 10px;
  padding: 12px 14px;
  backdrop-filter: blur(3px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  z-index: 200; /* ensure above other overlays */
}
.sec {
  margin-bottom: 8px;
}
.sec:last-child {
  margin-bottom: 0;
}
.sec-title {
  color: #9fb0ff;
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 6px;
}
/* Modal for ambientCG search */
.modal {
  position: absolute;
  inset: 0; /* fill the brush-hud area; stays inside pane due to brush-hud bounds */
  z-index: 250;
  pointer-events: auto;
}
.modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.35);
}
.modal-panel {
  position: absolute;
  top: 48px;
  right: 8px;
  width: min(840px, 92vw);        /* wider modal */
  min-height: 480px;              /* ensure a comfortably tall starting size */
  max-height: calc(100% - 24px);  /* nearly full pane height */
  background: rgba(14,16,20,0.98);
  border: 1px solid #2a2f3a;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-stamps .modal-panel {
  width: min(700px, 92vw);        /* stamps modal slightly narrower */
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid #2a2f3a;
}
.modal-subheader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid #2a2f3a;
  color: #cfd4e6;
  font-size: 12px;
}
.modal-subheader .url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}
.modal-subheader .url a {
  color: #9fb0ff;
  text-decoration: none;
}
.modal-subheader .url a:hover {
  text-decoration: underline;
}
.modal-subheader .meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.btn.small {
  padding: 3px 8px;
  font-size: 11px;
}
.modal-header .title {
  color: #9fb0ff;
  font-weight: 600;
  font-size: 14px;
}
.modal-header .btn.close {
  padding: 4px 8px;
}
.modal-body {
  padding: 8px;
  overflow: auto;
}
.loading, .error, .empty {
  padding: 10px;
  color: #cfd4e6;
}
.error { color: #ff8888; }
.results {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.result {
  display: grid;
  grid-template-rows: auto auto;
  gap: 6px;
  border: 1px solid #2a2f3a;
  border-radius: 8px;
  background: #151920;
  padding: 6px;
}
.thumb-wrap {
  width: 100%;
  aspect-ratio: 16/9;
  background: #0d0f13;
  border: 1px solid #202430;
  border-radius: 6px;
  overflow: hidden;
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}
.meta .name {
  font-size: 12px;
  color: #dde6ff;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.meta .btn.use {
  padding: 4px 8px;
  font-size: 12px;
}
</style>
