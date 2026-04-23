// React hook for subscribing to a batch's SSE stream. Mirrors the pattern used
// in `openLiveTranscript` (fetch + ReadableStream so we can attach the Bearer
// token — EventSource can't do custom headers).
//
// Events emitted by /api/calls/batch/{id}/events:
//   - `snapshot` (once):   { batch, counts, calls }
//   - `update`   (each):   { call_id, status, customer_name?, phone?, counts }
//   - `done`     (term):   { batch_uuid, status }
import { useEffect, useRef, useState } from 'react'
import { API_URL, getAccessToken } from '../../services/api'

export type BatchCounts = Record<string, number> & { _total?: number }

export type BatchCall = {
  id: string
  customer_name?: string
  phone?: string
  status: string
  call_duration?: number
  started_at?: string
  ended_at?: string
  category?: string
}

export type BatchSnapshot = {
  batch: any
  counts: BatchCounts
  calls: BatchCall[]
}

export type BatchUpdate = {
  call_id: string
  status: string
  customer_name?: string
  phone?: string
  counts?: BatchCounts
}

export function useBatchSSE(batchId: string | null | undefined, enabled = true) {
  const [snapshot, setSnapshot] = useState<BatchSnapshot | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!batchId || !enabled) {
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setDone(false)
    setError(null)

    const run = async () => {
      try {
        const token = getAccessToken()
        const resp = await fetch(`${API_URL}/api/calls/batch/${batchId}/events`, {
          headers: { Authorization: `Bearer ${token || ''}` },
          signal: controller.signal,
        })
        if (!resp.ok || !resp.body) throw new Error(`Stream failed (${resp.status})`)
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done: streamDone } = await reader.read()
          if (streamDone) break
          buffer += decoder.decode(value, { stream: true })
          const events = buffer.split('\n\n')
          buffer = events.pop() || ''
          for (const ev of events) {
            if (!ev.trim() || ev.startsWith(':')) continue
            let name = 'message'
            let data = ''
            for (const line of ev.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (!data) continue
            let parsed: any
            try {
              parsed = JSON.parse(data)
            } catch {
              continue
            }
            if (name === 'snapshot') {
              setSnapshot(parsed as BatchSnapshot)
            } else if (name === 'update') {
              const u = parsed as BatchUpdate
              setSnapshot((prev) => {
                if (!prev) return prev
                const calls = prev.calls.map((c) =>
                  c.id === u.call_id
                    ? { ...c, status: u.status, customer_name: u.customer_name ?? c.customer_name, phone: u.phone ?? c.phone }
                    : c,
                )
                return { ...prev, calls, counts: u.counts ? { ...prev.counts, ...u.counts } : prev.counts }
              })
            } else if (name === 'done') {
              setDone(true)
              return
            }
          }
        }
        setDone(true)
      } catch (err) {
        if ((err as any)?.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Stream error')
        }
      }
    }
    void run()
    return () => controller.abort()
  }, [batchId, enabled])

  return { snapshot, done, error, close: () => abortRef.current?.abort() }
}
