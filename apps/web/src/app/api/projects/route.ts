import { ProjectCreateSchema } from "@promptlab/contracts";
import { desc, isNull } from "drizzle-orm";
import { schema } from "@promptlab/db";

import { databaseOrUnavailable, safeApiFailure } from "@/lib/api";

export const runtime = "nodejs";

export async function GET() {
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  try {
    const projects = await database.db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        objective: schema.projects.objective,
      })
      .from(schema.projects)
      .where(isNull(schema.projects.deletedAt))
      .orderBy(desc(schema.projects.updatedAt));
    return Response.json({ projects });
  } catch {
    return safeApiFailure();
  }
}

export async function POST(request: Request) {
  const database = databaseOrUnavailable();
  if ("response" in database) return database.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = ProjectCreateSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "INVALID_PROJECT" }, { status: 400 });

  try {
    const [project] = await database.db
      .insert(schema.projects)
      .values(parsed.data)
      .returning({
        id: schema.projects.id,
        name: schema.projects.name,
        objective: schema.projects.objective,
      });
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return safeApiFailure(409);
    return safeApiFailure();
  }
}
