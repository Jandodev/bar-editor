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
})

let unsubs: Array<() => void> = []

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
  const updateOrtho = (v: any) => {
    const q = v && typeof v.screenRotationQuarter !== 'undefined' ? v.screenRotationQuarter : 0
    state.screenRotationQuarter = Number((((q as number) % 4) + 4) % 4)
  }

  // initial snapshot
  const t = bus.get('terrain'); if (t) updateTerrain(t as any)
  updateMetal(bus.get('metal'))
  updateBase(bus.get('baseTexture'))
  updateDisp(bus.get('display'))
  updateOverlays(bus.get('overlays'))
  updateEnv(bus.get('env'))
  updateOrtho(bus.get('ortho'))

  // subscribe to updates
  unsubs = [
    bus.subscribe('terrain', updateTerrain as any),
    bus.subscribe('metal', updateMetal as any),
    bus.subscribe('baseTexture', updateBase as any),
    bus.subscribe('display', updateDisp as any),
    bus.subscribe('overlays', updateOverlays as any),
    bus.subscribe('env', updateEnv as any),
    bus.subscribe('ortho', updateOrtho as any),
  ]
})

onBeforeUnmount(() => {
  for (const u of unsubs) {
    try { u() } catch {}
  }
  unsubs = []
})
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
    v-bind="mode === 'orthographic' ? { screenRotationQuarter: state.screenRotationQuarter } : {}"
  />
</template>
