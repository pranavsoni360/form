import { redirect } from "next/navigation";

// /vendor — entry hop. Layout guard sends to /vendor/login if unauthed;
// authed users see /vendor/dashboard.
export default function VendorIndexPage() {
  redirect("/vendor/dashboard");
}
