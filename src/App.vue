<script setup lang="ts">
import { ref, computed } from 'vue'
import ThreeViewport from './components/ThreeViewport.vue'
import { parseSMF, computeWorldSize, chooseStride, downsampleHeightField, type SMFParsed } from './lib/smf'

const smf = ref<SMFParsed | null>(null)
const errorMsg = ref<string | null>(null)

const widthWorld = ref(0)
const lengthWorld = ref(0)

const heights = ref<Float32Array | null>(null)
const gridW = ref(0)
const gridL = ref(0)
const strideUsed = ref(1)
const showMetal = ref(true)

const header = computed(() => smf.value?.header)

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
    // width/length are square counts (segments). Height grid is (width+1)x(length+1)
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

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  handleFiles(input.files)
}
</script>

<template>
  <header class="topbar">
    <div class="left">
      <label class="file">
        <input type="file" accept=".smf,application/octet-stream" @change="onFileChange" />
        <span>Load .smf</span>
      </label>
      <span class="status" v-if="header">
        Loaded: {{ header.width }}x{{ header.length }} squares, squareSize={{ header.squareSize }},
        height=[{{ header.minHeight }}, {{ header.maxHeight }}], stride={{ strideUsed }}
      </span>
      <span class="status warn" v-if="errorMsg">Error: {{ errorMsg }}</span>
      <label class="toggle">
        <input type="checkbox" v-model="showMetal" />
        <span>Show metal</span>
      </label>
    </div>
    <div class="right">
      <a href="https://springrts.com/wiki/Mapdev:SMF_format" target="_blank" rel="noreferrer">SMF spec</a>
    </div>
  </header>

  <main class="content">
    <div v-if="!heights" class="empty">
      <p>Select an .smf file to visualize the heightmap.</p>
      <p>This viewer parses header and height data in the browser and renders a displaced mesh using Three.js.</p>
    </div>
    <ThreeViewport
      v-else
      :widthWorld="widthWorld"
      :lengthWorld="lengthWorld"
      :gridW="gridW"
      :gridL="gridL"
      :heights="heights"
      :showMetal="showMetal"
      :metalU8="smf?.metalU8"
      :metalW="smf?.metalWidth"
      :metalL="smf?.metalLength"
    />
  </main>

  <section v-if="header" class="meta">
    <h3>Metadata</h3>
    <ul>
      <li>Magic: {{ header.magic }}</li>
      <li>Version: {{ header.version }}</li>
      <li>Map size (squares): {{ header.width }} x {{ header.length }}</li>
      <li>Square size: {{ header.squareSize }}</li>
      <li>Texels per square: {{ header.texelsPerSquare }}</li>
      <li>Tile size: {{ header.tileSize }}</li>
      <li>Min/Max Height: {{ header.minHeight }} / {{ header.maxHeight }}</li>
      <li>Offsets (bytes): HM={{ header.ofsHeightMap }}, Type={{ header.ofsTypeMap }}, Tiles={{ header.ofsTileIndex }}, Mini={{ header.ofsMiniMap }}, Metal={{ header.ofsMetalMap }}, Features={{ header.ofsFeatures }}</li>
      <li>Extra headers: {{ header.numExtraHeaders }}</li>
    </ul>
  </section>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a2a;
  background: #111214;
  color: #ddd;
}
.topbar .left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.topbar .right a {
  color: #7aa2ff;
  text-decoration: none;
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
}
.file input[type="file"] {
  display: none;
}
.status {
  font-size: 0.9rem;
  color: #aaa;
}
.status.warn {
  color: #ff7676;
}
.content {
  display: block;
}
.empty {
  padding: 24px;
  color: #aaa;
}
.meta {
  padding: 12px 16px 24px;
  color: #ccc;
  font-size: 0.95rem;
}
.meta ul {
  margin: 0;
  padding-left: 18px;
}
</style>
