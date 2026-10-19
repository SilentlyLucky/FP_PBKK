import { localWorkspaceRouteHandlers } from "@/lib/local-workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ projectId: string; grantId: string; patchId: string }>;
  },
) {
  const { projectId, grantId, patchId } = await context.params;
  return localWorkspaceRouteHandlers.evaluatePatch(
    request,
    projectId,
    grantId,
    patchId,
  );
}
