import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/features/auth'
import { registerServiceWorker } from '@/platform/pwa/register'
import App from './App'
import './index.css'

/**
 * Register the push worker once at boot, before anything is rendered.
 *
 * It is fire-and-forget and never gates the app: a browser that refuses to
 * register a worker still gets the full CRM, because the notification centre is
 * the source of truth and push is best effort (PRD 7.7). Permission is NOT
 * requested here — that only ever happens from a click on the notifications
 * screen, since a prompt on load is how an origin earns a permanent denial.
 */
void registerServiceWorker()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="teraso_crm_theme"
        >
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
