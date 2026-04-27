import { useEffect, useRef, useState } from 'react'
import { openLiveTranscript } from '../services/api'

export type TranscriptEntry = {
  role: 'agent' | 'user' | string
  text: string
  language?: string | null
  timestamp?: string | null
  final?: boolean
}

export function useLiveTranscript(callId: string | null, enabled = true) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!callId || !enabled) return
    setEntries([]); setDone(false); setError(null); setConnected(false)

    let mounted = true
    let close: () => void = () => {}

    void (async () => {
      close = await openLiveTranscript(callId, {
        onSnapshot: (items) => {
          if (!mounted) return
          setConnected(true)
          setEntries(Array.isArray(items) ? (items as TranscriptEntry[]) : [])
        },
        onEntry: (entry) => {
          if (!mounted) return
          setConnected(true)
          setEntries((prev) => mergeEntry(prev, entry))
        },
        onDone: () => { if (mounted) { setDone(true); setConnected(false) } },
        onError: (err) => { if (mounted) { setError(err.message); setConnected(false) } },
      })
      closeRef.current = close
    })()

    return () => { mounted = false; close() }
  }, [callId, enabled])

  return { entries, connected, done, error, close: () => closeRef.current() }
}

function mergeEntry(prev: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  // If the last entry is a partial from the same role, replace it; otherwise append.
  if (prev.length && prev[prev.length - 1].role === entry.role && prev[prev.length - 1].final === false) {
    return [...prev.slice(0, -1), entry]
  }
  return [...prev, entry]
}
