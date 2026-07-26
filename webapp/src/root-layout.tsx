import { Outlet } from '@tanstack/react-router'

import { Toaster } from '@/components/ui/sonner'

/**
 * The toaster is mounted once at the root so a confirmation raised by any
 * screen survives the navigation that follows it — creating a deal, for
 * instance, immediately opens the new card.
 */
export function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster position="bottom-center" richColors />
    </>
  )
}
