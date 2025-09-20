import { parseMapinfoLua, sanitizeMapinfoText, extractMapinfoTableSource } from '../lib/mapinfo'

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel) as HTMLElement | null
  if (!el) throw new Error(`Missing element: ${sel}`)
  return el
}

function setText(el: HTMLElement, text: string) {
  el.textContent = text
}

function setJSON(el: HTMLElement, obj: any) {
  el.textContent = JSON.stringify(obj, null, 2)
}

function setStatus(msg: string, ok = true) {
  const el = $('#status')
  el.textContent = msg
  el.className = ok ? 'status ok' : 'status err'
}

function parseNow() {
  const input = ($('#luaInput') as HTMLTextAreaElement).value || ''
  const jsonOut = $('#jsonOut')
  const errOut = $('#errOut')
  const sanOut = document.querySelector('#sanOut') as HTMLElement | null
  const extractOut = document.querySelector('#extractOut') as HTMLElement | null

  jsonOut.textContent = ''
  errOut.textContent = ''
  if (sanOut) sanOut.textContent = ''
  if (extractOut) extractOut.textContent = ''

  if (!input.trim()) {
    setStatus('No Lua provided', false)
    return
  }

  // Show sanitizer / extraction helpers for debugging too
  const sanitized = sanitizeMapinfoText(input)
  if (sanOut) sanOut.textContent = sanitized
  const extracted = extractMapinfoTableSource(sanitized)
  if (extractOut) extractOut.textContent = extracted || '(not extracted; full-file parse path used)'

  const t0 = performance.now()
  try {
    const obj = parseMapinfoLua(input)
    const dt = (performance.now() - t0).toFixed(2)
    setStatus(`Parsed OK in ${dt} ms`, true)
    setJSON(jsonOut, obj)
  } catch (e) {
    const dt = (performance.now() - t0).toFixed(2)
    setStatus(`Parse failed in ${dt} ms`, false)
    setText(errOut, (e as Error).stack || String(e))
  }
}

function loadFile(f: File) {
  const reader = new FileReader()
  reader.onload = () => {
    const txt = typeof reader.result === 'string' ? reader.result : ''
    ;($('#luaInput') as HTMLTextAreaElement).value = txt
    parseNow()
  }
  reader.onerror = () => {
    setStatus(`Failed reading file: ${f.name}`, false)
  }
  reader.readAsText(f)
}

function bootstrap() {
  // Wire buttons
  $('#parseBtn').addEventListener('click', parseNow)
  $('#clearBtn').addEventListener('click', () => {
    ;($('#luaInput') as HTMLTextAreaElement).value = ''
    setStatus('Cleared. Paste Lua and click Parse.', true)
    ;($('#jsonOut') as HTMLElement).textContent = ''
    ;($('#errOut') as HTMLElement).textContent = ''
  })

  // File input
  const fileInput = $('#fileInput') as HTMLInputElement
  fileInput.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    const files = input.files
    if (files && files.length > 0) {
      const f = files.item(0) as File
      loadFile(f)
    }
  })

  // Live parse on typing
  const ta = $('#luaInput') as HTMLTextAreaElement
  ta.addEventListener('input', () => {
    // Only parse when content is not empty
    if (ta.value.trim().length > 0) parseNow()
  })

  // Example
  const example = `-- Example mapinfo.lua samples:

-- return form
return {
  name = "MyMap",
  mapfile = "maps/mymap.smf",
  smf = {
    minHeight = -50,
    maxHeight = 300,
    minimapTex = "maps/mymap_minimap.png",
  },
  resources = {
    detailTex = "textures/detail.png",
    skyReflectModTex = "textures/sky.dds",
  },
}

-- local form
-- local mapinfo = {
--   name = "MyMap",
--   mapfile = "maps/mymap.smf",
--   smf = { minHeight = 0, maxHeight = 200 },
-- }
-- return mapinfo
`
  ;($('#luaInput') as HTMLTextAreaElement).value = example
  setStatus('Ready. Parsing example...', true)
  // Auto-parse the example so you immediately see JSON output
  parseNow()
}

document.addEventListener('DOMContentLoaded', bootstrap)
