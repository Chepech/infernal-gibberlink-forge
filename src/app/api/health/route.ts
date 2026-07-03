import { logInfo } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  logInfo("health.ok", { path: "/api/health" });

  return Response.json({
    ok: true,
    service: "infernal-gibberlink",
    storage: "none",
    externalServices: false,
    time: new Date().toISOString(),
  });
}
