/** Quotes every field and escapes embedded quotes — safe for any
 *  cell content (commas, newlines, quotes) without a CSV library. */
export function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`
  return rows.map((r) => r.map(escape).join(',')).join('\n')
}

/** Triggers a browser download of `content` as a file named `filename`
 *  — no server round-trip, the CSV is already in memory. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
