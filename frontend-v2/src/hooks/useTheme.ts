import { useEffect, useState, useCallback } from 'react'

const STORAGE_KEY = 'los-theme'
type Theme = 'light' | 'dark'

function getInitial(): Theme {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(theme: Theme) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.add('theme-transitioning')
  window.setTimeout(() => root.classList.remove('theme-transitioning'), 350)
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const initial = getInitial()
    if (typeof window !== 'undefined') apply(initial)
    return initial
  })

  useEffect(() => {
    apply(theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const toggle = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])
  return { theme, setTheme, toggle }
}
