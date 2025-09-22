<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive } from 'vue'
import ThreeViewport from '../ThreeViewport.vue'
import OrthoViewport from '../OrthoViewport.vue'
import type { ResourceBus } from '../../lib/editor/resource-bus'

type Props = {
  bus: ResourceBus
  mode: 'perspective' | 'orthographic'
}
const props = defineProps<Props>()

const state = reactive({
  widthWorld: 0,
  lengthWorld: 0,
  gridW: 0,
  gridL: 0,
  heights: null as Float32Array | null,

  showMetal: false,
  metalU8: undefined as Uint8Array | undefined,
  metalW: 0,
  metalL: 0,

  baseColorUrl: null as string | null,
  baseColorIsDDS: false,

  wireframe: false,
  showGrid: true,

  overlays: [] as any[],
  env: undefined as any,
  screenRotationQuarter: 0,
  images: [] as any[],
  atlasMode: false,
  profilerMode: false,

  // Editing config (shared via bus 'edit')
  editEnabled: false,
  editMode: 'add' as 'add' | 'remove' | 'smooth',
  editRadius: 64,
  editStrength: 2,
  editPreview: true,
})

let unsubs: Array<() => void> = []
// Debounce publishing terrain updates to the bus to avoid flooding during strokes
let terrainUpdateTimer: number | null = null
let pendingHeights: Float32Array | null = null

onMounted(() => {
  const { bus } = props

  const updateTerrain = (v: any) => {
    if (!v) return
    state.widthWorld = Number(v.widthWorld ?? 0)
    state.lengthWorld = Number(v.lengthWorld ?? 0)
    state.gridW = Number(v.gridW ?? 0)
    state.gridL = Number(v.gridL ?? 0)
    state.heights = (v.heights as Float32Array) ?? null
  }
  const updateMetal = (v: any) => {
    v = v || {}
    state.showMetal = !!v.showMetal
    state.metalU8 = v.metalU8 as Uint8Array | undefined
    state.metalW = Number(v.metalW ?? 0)
    state.metalL = Number(v.metalL ?? 0)
  }
  const updateBase = (v: any) => {
    v = v || {}
    state.baseColorUrl = (v.url ?? null) as string | null
    state.baseColorIsDDS = !!v.isDDS
  }
  const updateDisp = (v: any) => {
    v = v || {}
    state.wireframe = !!v.wireframe
    state.showGrid = v.showGrid ?? true
  }
  const updateOverlays = (v: any) => {
    state.overlays = Array.isArray(v) ? v : []
  }
  const updateEnv = (v: any) => {
    state.env = v || undefined
  }
  const updateImages = (v: any) => {
    state.images = Array.isArray(v) ? v : []
  }
  const updateOrtho = (v: any) => {
    const q = v && typeof v.screenRotationQuarter !== 'undefined' ? v.screenRotationQuarter : 0
    state.screenRotationQuarter = Number((((q as number) % 4) + 4) % 4)
    const view = v && typeof v.view === 'string' ? String(v.view) : 'terrain'
    state.atlasMode = view === 'atlas'
    state.profilerMode = view === 'profiler'
  }
  const updateEdit = (v: any) => {
    v = v || {}
    state.editEnabled = !!v.enabled
    const m = String(v.mode || state.editMode)
    state.editMode = (m === 'remove' || m === 'smooth') ? (m as any) : 'add'
    const r = Number(v.radius); state.editRadius = Number.isFinite(r) ? r : state.editRadius
    const s = Number(v.strength); state.editStrength = Number.isFinite(s) ? s : state.editStrength
    state.editPreview = !!v.preview
  }

  // initial snapshot
  const t = bus.get('terrain'); if (t) updateTerrain(t as any)
  updateMetal(bus.get('metal'))
  updateBase(bus.get('baseTexture'))
  updateDisp(bus.get('display'))
  updateOverlays(bus.get('overlays'))
  updateEnv(bus.get('env'))
  updateImages(bus.get('images'))
  updateOrtho(bus.get('ortho'))
  updateEdit(bus.get('edit'))

  // subscribe to updates
  unsubs = [
    bus.subscribe('terrain', updateTerrain as any),
    bus.subscribe('metal', updateMetal as any),
    bus.subscribe('baseTexture', updateBase as any),
    bus.subscribe('display', updateDisp as any),
    bus.subscribe('overlays', updateOverlays as any),
    bus.subscribe('env', updateEnv as any),
    bus.subscribe('images', updateImages as any),
    bus.subscribe('ortho', updateOrtho as any),
    bus.subscribe('edit', updateEdit as any),
  ]
})

onBeforeUnmount(() => {
  for (const u of unsubs) {
    try { u() } catch {}
  }
  unsubs = []
})
function onEditHeights(newHeights: Float32Array) {
  // Update local state so UI reacts immediately
  state.heights = newHeights

  // Debounce write-back to bus to reduce churn while painting
  pendingHeights = newHeights
  if (terrainUpdateTimer == null) {
    terrainUpdateTimer = window.setTimeout(() => {
      try {
        const heightsToSend = pendingHeights
        pendingHeights = null
        if (heightsToSend) {
          const terrain = {
            widthWorld: state.widthWorld,
            lengthWorld: state.lengthWorld,
            gridW: state.gridW,
            gridL: state.gridL,
            heights: heightsToSend,
          }
          ;(props.bus as any).set('terrain', terrain)
        }
      } finally {
        terrainUpdateTimer = null
      }
    }, 32) as unknown as number // ~30Hz publish max
  }
}

function onFps(newFps: number) {
  try {
    const prev = (props.bus.get('perf') as any) || {}
    const payload = { ...prev, [props.mode]: Number(newFps) || 0, ts: performance.now() }
    ;(props.bus as any).set('perf', payload)
  } catch {}
}
</script>

<template>
  <component
    :is="mode === 'orthographic' ? OrthoViewport : ThreeViewport"
    v-if="state.heights"
    :widthWorld="state.widthWorld"
    :lengthWorld="state.lengthWorld"
    :gridW="state.gridW"
    :gridL="state.gridL"
    :heights="state.heights!"
    :showMetal="state.showMetal"
    :metalU8="state.metalU8"
    :metalW="state.metalW"
    :metalL="state.metalL"
    :baseColorUrl="state.baseColorUrl"
    :baseColorIsDDS="state.baseColorIsDDS"
    :wireframe="state.wireframe"
    :showGrid="state.showGrid"
    :overlays="state.overlays"
    :env="state.env"
    v-bind="mode === 'orthographic' ? { screenRotationQuarter: state.screenRotationQuarter, atlasMode: state.atlasMode, atlasImages: state.images, profilerMode: state.profilerMode } : {}"
    :editEnabled="state.editEnabled"
    :editMode="state.editMode"
    :editRadius="state.editRadius"
    :editStrength="state.editStrength"
    :editPreview="state.editPreview"
    @editHeights="onEditHeights"
    @fps="onFps"
  />
</template>
