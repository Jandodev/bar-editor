// Dynamic brush docs loader (markdown).
//
// Put .md files under: src/plugins/brushes-docs/
// Naming convention: <brushId>.md (e.g., flatten.md, erode.md).
// Also provide an overview.md as a fallback.
//
// In Vite, we can import raw markdown strings with `as: 'raw'`.
// We guard the call for non-Vite contexts and return empty maps when unavailable.

export type BrushDocMap = Record<string, string>

let DOCS: BrushDocMap = {}
let OVERVIEW: string = '# Brushes\\nNo documentation available.'

function init() {
  try {
    // Eagerly import all markdown docs as raw strings
    const mods = (import.meta as any).glob?.('../../plugins/brushes-docs/**/*.md', { eager: true, as: 'raw' }) || {}
    for (const path in mods) {
      const raw: string = (mods as any)[path] as string
      // Extract filename without extension as id
      const m = path.match(/([^/\\\\]+)\\.md$/i)
      if (!m) continue
      const id = m[1].toLowerCase()
      if (id === 'overview') {
        OVERVIEW = raw || OVERVIEW
      } else {
        DOCS[id] = raw
      }
    }
  } catch (e) {
    // Non-Vite context or glob not supported
    DOCS = {}
    OVERVIEW = '# Brushes\\nDocumentation unavailable in this build.'
  }
}

// Initialize on module import
init()

export function getBrushDoc(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  return DOCS[String(id).toLowerCase()]
}

export function getOverviewDoc(): string {
  return OVERVIEW
}

export function listBrushDocIds(): string[] {
  return Object.keys(DOCS).sort()
}
