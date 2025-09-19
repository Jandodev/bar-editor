<script setup lang="ts">
import { ref, computed, watch } from 'vue'
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
const wireframe = ref(false)
const showGrid = ref(true)

// Folder-based textures
type ImgEntry = { name: string; url: string; file: File }
const folderImages = ref<ImgEntry[]>([])
const baseColorUrl = ref<string | null>(null)
const baseColorIsDDS = ref(false)

// Overlay controls built from folder images
type OverlayControl = { name: string; url: string; visible: boolean; opacity: number }
const overlays = ref<OverlayControl[]>([])

// Child ref for fullscreen API (still available if needed)
const viewportRef = ref<InstanceType<typeof ThreeViewport> | null>(null)

const header = computed(() => smf.value?.header)

function revokeFolderUrls() {
  for (const e of folderImages.value) URL.revokeObjectURL(e.url)
  folderImages.value = []
  baseColorUrl.value = null
  overlays.value = []
}

function pickBaseTextureURL(entries: ImgEntry[]): string | null {
  if (entries.length === 0) return null
  // Prefer common base color names (including .dds)
  const prefer = /(base|diffuse|albedo|color|texture)\.(png|jpe?g|webp|bmp|tga|dds)$/i
  const found = entries.find(e => prefer.test(e.name))
  return (found ?? entries[0]).url
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
  } catch (err) {
    console.error(err)
    errorMsg.value = (err as Error).message || String(err)
  }
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  handleFiles(input.files)
}

function onFolderChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  revokeFolderUrls()
  if (!files || files.length === 0) return
  const imgs: ImgEntry[] = []
  let foundSmf: File | null = null
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)!
    const name = f.webkitRelativePath || f.name
    if (/\.smf$/i.test(name)) {
      foundSmf = f
    }
    // Keep only image-like files (support DDS explicitly)
    if (/^image\//i.test(f.type) || /\.(png|jpe?g|webp|bmp|tga|dds)$/i.test(name)) {
      imgs.push({ name, url: URL.createObjectURL(f), file: f })
    }
  }
  // Sort for stable UI
  imgs.sort((a, b) => a.name.localeCompare(b.name))
  folderImages.value = imgs

  // Choose base texture and track if it's DDS (blob URLs hide extension)
  baseColorUrl.value = pickBaseTextureURL(imgs)
  const baseEntry = imgs.find(e => e.url === baseColorUrl.value)
  baseColorIsDDS.value = !!baseEntry && /\.dds$/i.test(baseEntry?.file.name || baseEntry?.name)

  // Build overlays with DDS hint so viewer uses DDSLoader even for blob: URLs
  overlays.value = imgs.map(img => ({
    name: img.name,
    url: img.url,
    visible: true,
    opacity: 1,
    isDDS: /\.dds$/i.test(img.file.name || img.name),
  }))

  // Auto-import .smf if present in the directory
  if (foundSmf) {
    loadSMFFromFile(foundSmf)
  }
}
watch(baseColorUrl, (newUrl) => {
  const baseEntry = folderImages.value.find(e => e.url === newUrl)
  baseColorIsDDS.value = !!baseEntry && /\.dds$/i.test(baseEntry?.file.name || baseEntry?.name)
})
</script>

<template>
  <div class="app">
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
        :overlays="overlays"
      />
    </div>

    <aside class="sidebar">
      <div class="section">
        <h3>Load</h3>
        <label class="file">
          <input type="file" accept=".smf,application/octet-stream" @change="onFileChange" />
          <span>Load .smf</span>
        </label>
        <label class="file">
          <input type="file" webkitdirectory directory multiple accept=".dds,image/*" @change="onFolderChange" />
          <span>Load map folder</span>
        </label>
        <div class="status warn" v-if="errorMsg">Error: {{ errorMsg }}</div>
      </div>

      <div class="section" v-if="header">
        <h3>Map Info</h3>
        <div class="info">
          <div><b>Size:</b> {{ header.width }}x{{ header.length }} squares</div>
          <div><b>Square:</b> {{ header.squareSize }}</div>
          <div><b>Height:</b> [{{ header.minHeight }}, {{ header.maxHeight }}]</div>
          <div><b>Stride:</b> {{ strideUsed }}</div>
        </div>
      </div>

      <div class="section">
        <h3>Display</h3>
        <label class="toggle">
          <input type="checkbox" v-model="showMetal" />
          <span>Metal</span>
        </label>
        <label class="toggle">
          <input type="checkbox" v-model="wireframe" />
          <span>Wireframe</span>
        </label>
        <label class="toggle">
          <input type="checkbox" v-model="showGrid" />
          <span>Grid</span>
        </label>
      </div>

      <div class="section">
        <h3>Base Texture</h3>
        <select v-model="baseColorUrl">
          <option :value="null">None</option>
          <option v-for="img in folderImages" :key="img.url" :value="img.url">{{ img.name }}</option>
        </select>
      </div>

      <div class="section" v-if="folderImages.length">
        <h3>Overlays</h3>
        <div class="overlays">
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
</template>

<style scoped>
.app {
  display: flex;
  width: 100vw;
  height: 100vh;
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
.sidebar {
  width: 320px;
  min-width: 260px;
  max-width: 420px;
  height: 100%;
  box-sizing: border-box;
  border-left: 1px solid #222;
  background: #111214;
  padding: 12px;
  overflow: auto;
}
.section {
  margin-bottom: 16px;
}
.section h3 {
  margin: 0 0 8px;
  font-size: 1rem;
  color: #9fb0ff;
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
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-slider {
  width: 100%;
}
</style>
