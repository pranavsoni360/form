import { redirect } from "next/navigation";

// Legacy operator dashboard route. Permanently redirects to the unified
// VirtualVaani-design /ops dashboard. The old static HTML at
// /agent-dashboard.html has been removed; all functionality lives under /ops/*.
export default function AgentLegacyRedirect() {
  redirect("/ops");
}
