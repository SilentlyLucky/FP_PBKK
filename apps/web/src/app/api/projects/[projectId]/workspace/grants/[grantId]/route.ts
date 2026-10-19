import { localWorkspaceRouteHandlers } from "@/lib/local-workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string; grantId: string }> },
) {
  const { projectId, grantId } = await context.params;
  return localWorkspaceRouteHandlers.revoke(request, projectId, grantId);
}
