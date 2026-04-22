import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  adminLogin, logout as apiLogout, portalLogin, restoreSession,
  getSessionRole, setAccessToken, type User,
} from '../services/api'

type AuthState = {
  user: User | null
  loading: boolean
  isAdmin: boolean
  isBank: boolean
  isVendor: boolean
  loginAdmin: (username: string, password: string) => Promise<User>
  loginPortal: (username: string, password: string, portal: 'bank' | 'vendor') => Promise<User>
  logout: () => Promise<void>
}

const AuthCtx = createContext<AuthState | null>(null)
const BROADCAST_CHANNEL = 'los-auth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Per-tab session restore: sessionStorage gate means fresh tabs start logged-out.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const restored = await restoreSession()
      if (!cancelled) {
        setUser(restored)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Cross-tab logout sync — when another tab with the SAME role logs out,
  // this tab drops its session too.
  useEffect(() => {
    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel(BROADCAST_CHANNEL)
    } catch {
      return
    }
    bc.onmessage = (ev) => {
      if (ev?.data?.type !== 'LOGOUT') return
      if (ev.data.role !== getSessionRole()) return
      setAccessToken(null)
      setUser(null)
    }
    return () => bc?.close()
  }, [])

  const loginAdmin = async (username: string, password: string) => {
    const data = await adminLogin(username, password)
    setUser(data.user)
    return data.user
  }

  const loginPortal = async (username: string, password: string, portal: 'bank' | 'vendor') => {
    const data = await portalLogin(username, password, portal)
    setUser(data.user)
    return data.user
  }

  const logout = async () => {
    const roleBefore = getSessionRole()
    await apiLogout()
    setUser(null)
    try {
      const bc = new BroadcastChannel(BROADCAST_CHANNEL)
      bc.postMessage({ type: 'LOGOUT', role: roleBefore })
      bc.close()
    } catch { /* ignore */ }
  }

  return (
    <AuthCtx.Provider
      value={{
        user,
        loading,
        isAdmin: user?.role === 'admin',
        isBank: user?.role === 'bank_user',
        isVendor: user?.role === 'vendor_user',
        loginAdmin,
        loginPortal,
        logout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
