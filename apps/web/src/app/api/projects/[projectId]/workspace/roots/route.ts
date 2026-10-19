import { localWorkspaceRootHandlers } from "@/lib/local-workspace-roots-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return localWorkspaceRootHandlers.list(request, projectId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return localWorkspaceRootHandlers.register(request, projectId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return localWorkspaceRootHandlers.revoke(request, projectId);
}
