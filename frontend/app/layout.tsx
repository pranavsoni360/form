import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bank Loan Application',
  description: 'Secure online loan application system',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              var theme = localStorage.getItem('los-theme');
              if (theme === 'dark') document.documentElement.classList.add('dark');
            } catch(e) {}
          })();
        `}} />
      </head>
      <body className="bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 transition-colors duration-200">
        {children}
      </body>
    </html>
  )
}
