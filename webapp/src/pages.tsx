import { Outlet, useLocation, useParams, useRouter, useSearch } from '@tanstack/react-router'
import type { UserDto, UserRole } from '@teraso-crm/contracts'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  NotFoundSection,
  SessionErrorSection,
  SessionLoadingSection,
} from '@/components/WebRouteSections'
import { WorkspaceShell } from '@/components/WorkspaceShell'
import { AdminDashboard, AdminSettings, AdminUsers } from '@/features/admin'
import {
  AuthPageShell,
  clearPasswordResetTokenHash,
  ForgotPasswordForm,
  LoginForm,
  RegisterForm,
  readPasswordResetToken,
  ResetPasswordForm,
  useAuth,
} from '@/features/auth'
import {
  CrmBoardPage,
  CrmDashboardPage,
  CrmDealPage,
  CrmDealsPage,
  CrmNotificationsPage,
  CrmTasksPage,
  DEAL_DETAIL_ROUTE_PATH,
} from '@/features/crm'
import {
  canOpenWorkspace,
  homePathForRole,
  safeReturnPath,
  type WorkspaceKind,
} from '@/features/navigation'
import { UserHome, UserProfile, UserSettings } from '@/features/users'

export function HomePage() {
  const auth = useAuth()
  const { returnTo } = useSearch({ from: '/' })

  if (auth.isBootstrapping) return <SessionLoadingSection />
  if (auth.sessionError && !auth.user) {
    return <SessionErrorSection retry={auth.retrySession} />
  }
  if (auth.user) {
    return (
      <HrefRedirect
        href={safeReturnPath(auth.user.role, returnTo) ?? homePathForRole(auth.user.role)}
      />
    )
  }
  const destination = returnTo
    ? `/login?returnTo=${encodeURIComponent(returnTo)}`
    : '/login'
  return <HrefRedirect href={destination} />
}

export function LoginPage() {
  const { returnTo } = useSearch({ from: '/login' })
  return (
    <GuestAuthPage returnTo={returnTo}>
      <AuthPageShell>
        <LoginForm returnTo={returnTo} />
      </AuthPageShell>
    </GuestAuthPage>
  )
}

export function SignupPage() {
  const { returnTo } = useSearch({ from: '/signup' })
  return (
    <GuestAuthPage returnTo={returnTo}>
      <AuthPageShell>
        <RegisterForm returnTo={returnTo} />
      </AuthPageShell>
    </GuestAuthPage>
  )
}

export function ForgotPasswordPage() {
  return (
    <GuestAuthPage>
      <AuthPageShell>
        <ForgotPasswordForm />
      </AuthPageShell>
    </GuestAuthPage>
  )
}

export function ResetPasswordPage() {
  const auth = useAuth()
  const token = usePasswordResetToken()
  if (auth.isBootstrapping) return <SessionLoadingSection />

  return (
    <AuthPageShell>
      <ResetPasswordForm token={token} />
    </AuthPageShell>
  )
}

export function UserHomePage() {
  return <UserHome user={useWorkspaceUser()} />
}

export function CrmDashboardRoutePage() {
  return <CrmDashboardPage />
}

/**
 * The CRM routes hang off the pathless `userWorkspace` layout, so their route
 * ids carry that prefix even though their URLs do not. Reading search and
 * params here keeps that routing detail in the routing layer: the feature
 * components take plain props.
 */
export function CrmDealsRoutePage() {
  const search = useSearch({ from: '/userWorkspace/app/deals' })
  return <CrmDealsPage search={search} />
}

export function CrmDealRoutePage() {
  const { dealId } = useParams({ from: `/userWorkspace${DEAL_DETAIL_ROUTE_PATH}` })
  return <CrmDealPage dealId={dealId} />
}

export function CrmBoardRoutePage() {
  return <CrmBoardPage />
}

export function CrmTasksRoutePage() {
  return <CrmTasksPage />
}

export function CrmNotificationsRoutePage() {
  return <CrmNotificationsPage />
}

export function UserProfilePage() {
  return <UserProfile user={useWorkspaceUser()} />
}

export function UserSettingsPage() {
  const auth = useAuth()
  return <UserSettings onLogout={auth.logout} />
}

export function AdminDashboardPage() {
  return <AdminDashboard />
}

export function AdminUsersPage() {
  return <AdminUsers currentUser={useWorkspaceUser('admin')} />
}

export function AdminSettingsPage() {
  return <AdminSettings user={useWorkspaceUser('admin')} />
}

export function UserWorkspaceLayout() {
  return <WorkspaceRoute workspace="crm" />
}

export function AdminWorkspaceLayout() {
  return <WorkspaceRoute workspace="admin" />
}

export function NotFoundPage() {
  const auth = useAuth()

  if (auth.isBootstrapping) return <SessionLoadingSection />
  if (auth.sessionError && !auth.user) {
    return <SessionErrorSection retry={auth.retrySession} />
  }

  const destination = auth.user ? homePathForRole(auth.user.role) : '/login'
  return <NotFoundSection destination={destination} />
}

/**
 * The guard is per workspace, not per role: the CRM asks only for a signed-in
 * account, the account console still asks for an administrator. Gating `/app`
 * on `role === 'user'` locked the seeded administrator — the only account a
 * fresh deployment has — out of the product, and made every notification link
 * it receives a dead one.
 */
function WorkspaceRoute({ workspace }: { workspace: WorkspaceKind }) {
  const auth = useAuth()
  const location = useLocation()

  if (auth.isBootstrapping) return <SessionLoadingSection />
  if (auth.sessionError && !auth.user) {
    return <SessionErrorSection retry={auth.retrySession} />
  }
  if (!auth.user) {
    const returnTo = `${location.pathname}${location.searchStr}`
    return <HrefRedirect href={`/login?returnTo=${encodeURIComponent(returnTo)}`} />
  }
  if (!canOpenWorkspace(workspace, auth.user.role)) {
    return <HrefRedirect href={homePathForRole(auth.user.role)} />
  }

  return (
    <WorkspaceShell onLogout={auth.logout} user={auth.user} workspace={workspace}>
      <Outlet />
    </WorkspaceShell>
  )
}

function GuestAuthPage({
  children,
  returnTo,
}: {
  children: ReactNode
  returnTo?: string
}) {
  const auth = useAuth()

  if (auth.isBootstrapping) return <SessionLoadingSection />
  if (auth.sessionError && !auth.user) {
    return <SessionErrorSection retry={auth.retrySession} />
  }
  if (auth.user) {
    return (
      <HrefRedirect
        href={safeReturnPath(auth.user.role, returnTo) ?? homePathForRole(auth.user.role)}
      />
    )
  }

  return children
}

function usePasswordResetToken() {
  const [token, setToken] = useState(() => {
    if (typeof window === 'undefined') return ''
    return readPasswordResetToken(window.location)
  })

  useEffect(() => {
    const captureToken = () => {
      const nextToken = readPasswordResetToken(window.location)
      if (!nextToken) return
      setToken(nextToken)
      clearPasswordResetTokenHash(window.location, window.history)
    }

    captureToken()
    window.addEventListener('hashchange', captureToken)
    return () => window.removeEventListener('hashchange', captureToken)
  }, [])

  return token
}

/** Asserts the guarded layout above actually ran; `role` narrows it further. */
function useWorkspaceUser(role?: UserRole): UserDto {
  const user = useAuth().user
  if (!user || (role && user.role !== role)) {
    throw new Error('Workspace page rendered outside its guarded layout')
  }
  return user
}

function HrefRedirect({ href }: { href: string }) {
  const router = useRouter()
  const hasRedirected = useRef(false)
  useEffect(() => {
    if (hasRedirected.current) return
    hasRedirected.current = true
    router.history.replace(href)
  }, [href, router])
  return null
}
