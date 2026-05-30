import { useState, useEffect, useCallback } from 'react'

interface KeloUpdateState {
  available: boolean
  version: string | null
  progress: number
  downloading: boolean
  error: string | null
}

interface KeloAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>
  on: (channel: string, handler: (...args: any[]) => void) => () => void
}

function getKeloAPI(): KeloAPI | null {
  const w = window as any
  if (w.electronAPI?.kelo) return w.electronAPI.kelo
  if (w.kelo) return w.kelo
  if (w.electronAPI?.invoke) {
    return {
      invoke: w.electronAPI.invoke,
      on: (channel: string, handler: (...args: any[]) => void) => {
        w.electronAPI.on(channel, handler)
        return () => {
          if (typeof w.electronAPI.removeListener === 'function') {
            w.electronAPI.removeListener(channel, handler)
          }
        }
      },
    }
  }
  return null
}

export function useKeloUpdate() {
  const [state, setState] = useState<KeloUpdateState>({
    available: false,
    version: null,
    progress: 0,
    downloading: false,
    error: null,
  })

  useEffect(() => {
    const api = getKeloAPI()
    if (!api) return

    const cleanup = api.on('kelo:update-available', (...args: any[]) => {
      const data = args[1] || args[0]
      setState(s => ({ ...s, available: true, version: data.version }))
    })

    const cleanupProgress = api.on('kelo:progress', (...args: any[]) => {
      const data = args[1] || args[0]
      const pct = data.total > 0 ? Math.round((data.downloaded / data.total) * 100) : 0
      setState(s => ({ ...s, progress: pct }))
    })

    api.invoke('kelo:check').then((update: any) => {
      if (update) {
        setState(s => ({ ...s, available: true, version: update.version }))
      }
    }).catch((err: any) => {
      console.warn('[kelo] Initial update check failed:', err?.message || err)
    })

    return () => {
      cleanup()
      cleanupProgress()
    }
  }, [])

  const download = useCallback(async () => {
    const api = getKeloAPI()
    if (!api || !state.available) return

    setState(s => ({ ...s, downloading: true, error: null, progress: 0 }))

    try {
      const result = await api.invoke('kelo:download')
      if (result.success) {
        setState(s => ({ ...s, downloading: false, progress: 100 }))
        setTimeout(() => api.invoke('kelo:apply'), 1000)
      } else {
        setState(s => ({ ...s, downloading: false, error: result.error }))
      }
    } catch (err: any) {
      setState(s => ({ ...s, downloading: false, error: err?.message || 'Download failed' }))
    }
  }, [state.available])

  return {
    ...state,
    download,
  }
}
