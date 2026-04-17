import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { adminLogin, logout as apiLogout, portalLogin, restoreSession, type User } from '../services/api'

type AuthState = {
  user: User | null
  loading: boolean
  isAdmin: boolean
  isBank: boolean
  isVendor: boolean
  loginAdmin: (email: string, password: string) => Promise<User>
  loginPortal: (username: string, password: string, portal: 'bank' | 'vendor') => Promise<User>
  logout: () => Promise<void>
}

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

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

  const loginAdmin = async (email: string, password: string) => {
    const data = await adminLogin(email, password)
    setUser(data.user)
    return data.user
  }

  const loginPortal = async (username: string, password: string, portal: 'bank' | 'vendor') => {
    const data = await portalLogin(username, password, portal)
    setUser(data.user)
    return data.user
  }

  const logout = async () => {
    await apiLogout()
    setUser(null)
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
