<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, computed } from 'vue'
import type { ResourceBus } from '../../lib/editor/resource-bus'
import { brushRegistry } from '../../lib/brushes'

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
      </template>

      <!-- Preview toggle -->
      <button class="pill" :class="{ on: state.preview }" @click="publishEdit({ preview: !state.preview })" title="Toggle brush preview">
        <span class="dot" :class="{ on: state.preview }"></span>
        <span>Preview</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.brush-hud {
  position: absolute;
  top: 8px;
  right: 8px;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
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
  top: 40px;
  right: 0;
  min-width: 280px;
  max-width: 420px;
  background: rgba(12, 14, 18, 0.95);
  border: 1px solid #2a2f3a;
  border-radius: 10px;
  padding: 8px 10px;
  backdrop-filter: blur(3px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
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
</style>
