'use client';

import {
  LayoutDashboard, FileText, Phone, Layers, Bot,
} from 'lucide-react';
import Sidebar, { type NavItem } from '@/components/shared/Sidebar';
import TopNav from '@/components/shared/TopNav';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { usePathname } from 'next/navigation';

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',    href: '/bank/dashboard',    icon: <LayoutDashboard className="w-5 h-5" /> },
  { label: 'Applications', href: '/bank/applications', icon: <FileText className="w-5 h-5" /> },
  { label: 'Calls',        href: '/bank/calls',        icon: <Phone className="w-5 h-5" /> },
  { label: 'Batch',        href: '/bank/batch',        icon: <Layers className="w-5 h-5" /> },
  { label: 'Agent',        href: '/bank/agent',        icon: <Bot className="w-5 h-5" /> },
];

export default function BankLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = pathname === '/bank/login' || pathname === '/bank/account-form';

  if (isPublic) return <>{children}</>;

  return (
    <AuthGuard type="bank">
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex">
        <Sidebar items={NAV_ITEMS} portalName="Bank Portal" portalColor="bg-blue-600" authType="bank" />
        <div className="flex-1 ml-60 flex flex-col min-h-screen">
          <TopNav authType="bank" />
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
