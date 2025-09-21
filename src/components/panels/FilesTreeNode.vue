<script lang="ts">
import { defineComponent, type PropType } from 'vue'

export type UploadedEntry = {
  path: string
  url?: string
  isImage: boolean
  isDDS: boolean
  file?: File
}

export type TreeNode = {
  name: string
  path: string
  isDir: boolean
  children?: TreeNode[]
  entry?: UploadedEntry
}

export default defineComponent({
  name: 'FilesTreeNode',
  props: {
    node: { type: Object as PropType<TreeNode>, required: true },
    expandedSet: { type: Object as PropType<Set<string>>, required: true },
    selectedPath: { type: String as PropType<string | null>, default: null },
  },
  emits: ['toggle', 'select', 'parseMapinfo', 'loadSmf', 'overlay', 'useAsBase'],
  computed: {
    expanded(): boolean {
      return this.node.isDir ? this.expandedSet.has(this.node.path) : false
    },
    isSelected(): boolean {
      return this.selectedPath === this.node.path
    },
  },
  methods: {
    onToggle(e: MouseEvent) {
      e.stopPropagation()
      this.$emit('toggle', this.node.path)
    },
    onSelect() {
      this.$emit('select', this.node.path)
    },
    isLua(path: string): boolean {
      return /\.lua$/i.test(path)
    },
    isSmf(path: string): boolean {
      return /\.smf$/i.test(path)
    },
    onParseMapinfo(e: MouseEvent) {
      e.stopPropagation()
      if (this.node.entry) this.$emit('parseMapinfo', this.node.entry)
    },
    onLoadSmf(e: MouseEvent) {
      e.stopPropagation()
      if (this.node.entry) this.$emit('loadSmf', this.node.entry)
    },
    onOverlay(e: MouseEvent) {
      e.stopPropagation()
      if (this.node.entry) this.$emit('overlay', this.node.entry)
    },
    onUseAsBase(e: MouseEvent) {
      e.stopPropagation()
      if (this.node.entry) this.$emit('useAsBase', this.node.entry)
    },
  },
})
</script>

<template>
  <div class="fb-node">
    <div class="fb-row" :class="{ selected: isSelected }" @click="onSelect">
      <div class="fb-path">
        <span
          v-if="node.isDir"
          class="twisty"
          @click="onToggle"
        >{{ expanded ? '▼' : '▶' }}</span>
        <span class="icon">
          <template v-if="node.isDir">📁</template>
          <template v-else>
            {{ node.entry?.isDDS ? '🗜️' : (node.entry?.isImage ? '🖼️' : '📄') }}
          </template>
        </span>
        <span :class="node.isDir ? 'dir' : 'file'">{{ node.name }}</span>
      </div>
      <div class="fb-tags">
        <span v-if="node.isDir" class="tag">Folder</span>
        <span v-else-if="node.entry?.isDDS" class="tag">DDS</span>
        <span v-else-if="node.entry?.isImage" class="tag">Image</span>

        <button
          v-if="isLua(node.path)"
          class="small"
          :disabled="!node.entry?.file"
          @click="onParseMapinfo"
        >Parse mapinfo</button>

        <button
          v-if="isSmf(node.path)"
          class="small"
          :disabled="!node.entry?.file"
          @click="onLoadSmf"
        >Load SMF</button>

        <button
          v-if="node.entry?.isImage"
          class="small"
          @click="onOverlay"
        >Overlay</button>

        <button
          v-if="node.entry?.isImage"
          class="small"
          @click="onUseAsBase"
        >Use as base</button>
      </div>
    </div>

    <div v-if="node.isDir && expanded && node.children?.length" class="fb-children">
      <FilesTreeNode
        v-for="c in node.children"
        :key="c.path"
        :node="c"
        :expanded-set="expandedSet"
        :selected-path="selectedPath"
        @toggle="$emit('toggle', $event)"
        @select="$emit('select', $event)"
        @parseMapinfo="$emit('parseMapinfo', $event)"
        @loadSmf="$emit('loadSmf', $event)"
        @overlay="$emit('overlay', $event)"
        @useAsBase="$emit('useAsBase', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.fb-node { margin-left: 0; }
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
  cursor: pointer;
}
.dir { color: #b8c6ff; font-weight: 600; }
.file { color: #d9e0ff; }
.fb-row.selected { background: #1a1c20; }
.fb-path .icon { color: #c0c4d4; }

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
button.small {
  padding: 4px 8px;
  font-size: 0.85rem;
}
</style>
