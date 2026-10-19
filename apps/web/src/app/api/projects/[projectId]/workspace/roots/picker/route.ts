import { localWorkspaceRootHandlers } from "@/lib/local-workspace-roots-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return localWorkspaceRootHandlers.pickerListing(request, projectId);
}
