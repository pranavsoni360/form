"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { getAccessToken } from "@/lib/auth";

/**
 * /vendor/* route gate.
 *
 * Login page (/vendor/login) is exempt — it sets the token. Every other path
 * requires a valid los_vendor_token; otherwise we bounce to /vendor/login
 * with ?redirect=<original-path> so the user lands where they tried to go.
 */
export default function VendorLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/vendor/login";

  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    const token = getAccessToken("vendor");
    if (!token) {
      const dest = pathname || "/vendor/dashboard";
      router.replace(`/vendor/login?redirect=${encodeURIComponent(dest)}`);
      return;
    }
    setReady(true);
  }, [router, pathname, isLogin]);

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-slate-500">
        <div className="text-sm">Verifying vendor session…</div>
      </div>
    );
  }

  return <>{children}</>;
}
