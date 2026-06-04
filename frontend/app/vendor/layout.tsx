'use client';

import { LayoutDashboard, FileText, Banknote } from 'lucide-react';
import Sidebar, { type NavItem } from '@/components/shared/Sidebar';
import TopNav from '@/components/shared/TopNav';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { usePathname } from 'next/navigation';

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',    href: '/vendor/dashboard',    icon: <LayoutDashboard className="w-5 h-5" /> },
  { label: 'Applications', href: '/vendor/applications', icon: <FileText className="w-5 h-5" /> },
  { label: 'Settlements',  href: '/vendor/settlements',  icon: <Banknote className="w-5 h-5" /> },
];

export default function VendorLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin  = pathname === '/vendor/login';

  if (isLogin) return <>{children}</>;

  return (
    <AuthGuard type="vendor">
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex">
        <Sidebar items={NAV_ITEMS} portalName="Vendor Portal" portalColor="bg-emerald-600" authType="vendor" />
        <div className="flex-1 ml-60 flex flex-col min-h-screen">
          <TopNav authType="vendor" />
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
