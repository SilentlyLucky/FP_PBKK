import { localWorkspaceRouteHandlers } from "@/lib/local-workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return localWorkspaceRouteHandlers.approveWrite(request, projectId);
}
